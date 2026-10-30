// Plan A3.1 unit tests: the re-exec rule (shouldReexec, childEnv) and the 401
// retry in run.ts with a fake fetch, clock and sleep (no real waiting).
import { describe, expect, it } from 'vitest';
import { PROXY_FLAG, REEXEC_MARKER, childEnv, shouldReexec } from '../src/reexec.js';
import { MIN_RETRY_SEND_MS, RETRY_DELAY_MS, SEND_TIMEOUT_MS, emit, type EmitDeps } from '../src/run.js';
import { LOCAL_HEADER_VALUE, dataDirWithToken, fixture } from './helpers.js';

const SESSION_START = fixture('pc2', '001-SessionStart-exec.json');
const CLOUD = { CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_1', AGENT_OFFICE_RELAY_URL: 'https://relay.test' };
const PROXY = 'http://127.0.0.1:1';

describe('shouldReexec', () => {
  it.each([
    ['cloud + HTTPS_PROXY', { ...CLOUD, HTTPS_PROXY: PROXY }, true],
    ['cloud + https_proxy', { ...CLOUD, https_proxy: PROXY }, true],
    ['cloud + HTTPS_PROXY + flag "0"', { ...CLOUD, HTTPS_PROXY: PROXY, [PROXY_FLAG]: '0' }, true],
    ['cloud + HTTPS_PROXY + flag "1"', { ...CLOUD, HTTPS_PROXY: PROXY, [PROXY_FLAG]: '1' }, false],
    ['cloud + HTTPS_PROXY + marker', { ...CLOUD, HTTPS_PROXY: PROXY, [REEXEC_MARKER]: '1' }, false],
    ['cloud + HTTPS_PROXY + empty marker', { ...CLOUD, HTTPS_PROXY: PROXY, [REEXEC_MARKER]: '' }, false],
    ['cloud, no proxy', { ...CLOUD }, false],
    ['cloud, blank proxy', { ...CLOUD, HTTPS_PROXY: '  ' }, false],
    ['cloud, HTTPS_PROXY but empty https_proxy (Node uses the lowercase one)', { ...CLOUD, HTTPS_PROXY: PROXY, https_proxy: '' }, false],
    ['cloud, only HTTP_PROXY', { ...CLOUD, HTTP_PROXY: PROXY }, false],
    ['cloud + proxy, no relay URL', { CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_1', HTTPS_PROXY: PROXY }, false],
    ['PC + proxy', { HTTPS_PROXY: PROXY, AGENT_OFFICE_RELAY_URL: 'https://relay.test' }, false],
    ['PC + proxy, empty remote id', { ...CLOUD, CLAUDE_CODE_REMOTE_SESSION_ID: '', HTTPS_PROXY: PROXY }, false],
  ])('%s -> %s', (_n, env, want) => {
    expect(shouldReexec(env)).toBe(want);
  });

  it('childEnv keeps everything and adds the flag and the marker (and the child never re-runs)', () => {
    const env = { ...CLOUD, HTTPS_PROXY: PROXY, OTHER: 'x' };
    const c = childEnv(env);
    expect(c).toEqual({ ...env, [PROXY_FLAG]: '1', [REEXEC_MARKER]: '1' });
    expect(shouldReexec(c)).toBe(false);
    expect(env).not.toHaveProperty(REEXEC_MARKER);
  });
});

interface Rig {
  readonly deps: EmitDeps;
  readonly calls: { url: string; headers: Record<string, string> }[];
  readonly sleeps: number[];
}

function rig(statuses: number[], opts: { deadline?: number; failFirst?: boolean } = {}): Rig {
  let t = 1_000_000;
  const calls: Rig['calls'] = [];
  const sleeps: number[] = [];
  const deps: EmitDeps = {
    fetch: (url, init) => {
      calls.push({ url: url instanceof Request ? url.url : url.toString(), headers: init?.headers as Record<string, string> });
      if (opts.failFirst === true && calls.length === 1) return Promise.reject(new Error('down'));
      const status = statuses[Math.min(calls.length - 1, statuses.length - 1)] ?? 204;
      return Promise.resolve(new Response(null, { status }));
    },
    now: () => t,
    readToken: () => LOCAL_HEADER_VALUE,
    nonce: () => 'n'.repeat(32),
    deadline: opts.deadline === undefined ? undefined : 1_000_000 + opts.deadline,
    sleep: (ms) => {
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
  };
  return { deps, calls, sleeps };
}

describe('401 retry (run.ts)', () => {
  it('cloud 401 then 204 -> 2 posts, one pause of RETRY_DELAY_MS, no Authorization header', async () => {
    const r = rig([401, 204]);
    expect(await emit(CLOUD, SESSION_START, '/x/emit.mjs', r.deps)).toBe('sent');
    expect(r.calls).toHaveLength(2);
    expect(r.sleeps).toEqual([RETRY_DELAY_MS]);
    for (const c of r.calls) {
      expect(c.url).toBe('https://relay.test/ingest');
      expect(Object.keys(c.headers).map((k) => k.toLowerCase())).toEqual(['content-type']);
    }
  });

  it('cloud 401 twice -> 2 posts only', async () => {
    const r = rig([401, 401, 401]);
    await emit(CLOUD, SESSION_START, '/x/emit.mjs', r.deps);
    expect(r.calls).toHaveLength(2);
  });

  it('PC 401 -> no retry', async () => {
    const r = rig([401, 204]);
    await emit({ AGENT_OFFICE_HOME: dataDirWithToken() }, SESSION_START, '/x/emit.mjs', r.deps);
    expect(r.calls).toHaveLength(1);
    expect(r.sleeps).toEqual([]);
  });

  it('a network error is not retried', async () => {
    const r = rig([204], { failFirst: true });
    expect(await emit(CLOUD, SESSION_START, '/x/emit.mjs', r.deps)).toBe('send-failed');
    expect(r.calls).toHaveLength(1);
  });

  it('no retry when the deadline leaves too little time', async () => {
    const r = rig([401, 204], { deadline: RETRY_DELAY_MS + MIN_RETRY_SEND_MS - 1 });
    await emit(CLOUD, SESSION_START, '/x/emit.mjs', r.deps);
    expect(r.calls).toHaveLength(1);
  });

  it('retries when exactly enough time is left', async () => {
    const r = rig([401, 204], { deadline: RETRY_DELAY_MS + MIN_RETRY_SEND_MS });
    await emit(CLOUD, SESSION_START, '/x/emit.mjs', r.deps);
    expect(r.calls).toHaveLength(2);
  });

  it('the send timeout never goes past the deadline', async () => {
    const t = 0;
    const signals: AbortSignal[] = [];
    const deps: EmitDeps = {
      fetch: (_u, init) => {
        if (init?.signal) signals.push(init.signal);
        return Promise.resolve(new Response(null, { status: 204 }));
      },
      now: () => t,
      readToken: () => undefined,
      nonce: () => 'n',
      deadline: 100,
    };
    await emit(CLOUD, SESSION_START, '/x/emit.mjs', deps);
    expect(signals).toHaveLength(1);
    // AbortSignal.timeout(100) aborts long before SEND_TIMEOUT_MS.
    await new Promise((r) => setTimeout(r, 250));
    expect(signals[0]?.aborted).toBe(true);
    expect(SEND_TIMEOUT_MS).toBeGreaterThan(250);
  });
});
