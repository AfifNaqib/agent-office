// Plan A3.1 acceptance tests (AC 1 to 6; AC 7 cwd part is in build.test.ts): the
// BUILT file is spawned. A probe loaded through NODE_OPTIONS logs every node
// process of a run, so "exactly one child with flag and marker" is observed from
// outside, without any test hook in the shipped code.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OfficeEventSchema } from '@agent-office/core';
import { BUILT, PKG, buildEmit, dataDirWithToken, fixture, mockServer, runEmit, type Mock, type RunResult } from './helpers.js';
import { RELAY_HOST, alive, makeCert, mockProxy, probe, scriptedRelay, type Proxy, type Relay, type Seen } from './proxy-helpers.js';

const PO_PROMPT = fixture('pc-desktop', '010-UserPromptSubmit-exec.json');
const SESSION_START = fixture('pc2', '001-SessionStart-exec.json');
const REMOTE = 'cse_01ABCdef23';
const CERT = makeCert();

const closers: (() => Promise<void>)[] = [];
function track<T extends { close(): Promise<void> }>(x: T): T {
  closers.push(() => x.close());
  return x;
}
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

beforeAll(() => {
  buildEmit();
});

const proxy = async (opts: Parameters<typeof mockProxy>[0] = {}): Promise<Proxy> => track(await mockProxy(opts));
const relay = async (statuses: number[] = [204]): Promise<Relay> => track(await scriptedRelay(statuses));
const bridge = async (): Promise<Mock> => track(await mockServer());

/** Cloud env behind the mock proxy, relay = https://relay.test (only reachable through the proxy). */
function cloudBehindProxy(p: Proxy, extra: Record<string, string> = {}): Record<string, string> {
  return { CLAUDE_CODE_REMOTE_SESSION_ID: REMOTE, AGENT_OFFICE_RELAY_URL: `https://${RELAY_HOST}`, HTTPS_PROXY: p.url, ...extra };
}

function expectSilent(r: RunResult): void {
  expect(r.code).toBe(0);
  expect(r.stdout).toBe('');
  expect(r.stderr).toBe('');
}

/** AC6: no request this script makes carries a credential. */
function expectNoAuth(headers: Seen['headers']): void {
  expect(headers.authorization).toBeUndefined();
  expect(headers['proxy-authorization']).toBeUndefined();
  expect(headers['x-agent-office-local']).toBeUndefined();
}

describe('A3.1 AC1: cloud + HTTPS_PROXY + flag unset -> one re-exec through the proxy', () => {
  it.each(['HTTPS_PROXY', 'https_proxy'])('%s: exactly one child, with flag and marker; the proxy sees CONNECT to the relay host', async (name) => {
    const p = await proxy();
    const pr = probe();
    const env = cloudBehindProxy(p, pr.env);
    if (name === 'https_proxy') {
      env.https_proxy = env.HTTPS_PROXY ?? '';
      delete env.HTTPS_PROXY;
    }
    const r = await runEmit(PO_PROMPT, env);
    expectSilent(r);
    const lines = pr.lines();
    expect(lines).toHaveLength(2);
    const [parent, child] = lines;
    expect(parent).toMatchObject({ flag: null, marker: null });
    expect(child).toMatchObject({ flag: '1', marker: '1', ppid: parent?.pid });
    expect(p.connects.map((c) => c.target)).toEqual([`${RELAY_HOST}:443`]);
    expect(p.forwards).toEqual([]);
    for (const c of p.connects) expectNoAuth(c.headers);
  });

  it.skipIf(CERT === null)('end to end through a TLS tunnel: the relay gets one valid cloud event on /ingest, no Authorization', async () => {
    const p = await proxy({ tls: CERT ?? undefined });
    const pr = probe();
    const r = await runEmit(PO_PROMPT, cloudBehindProxy(p, { ...pr.env, NODE_EXTRA_CA_CERTS: CERT?.certFile ?? '' }));
    expectSilent(r);
    expect(pr.lines()).toHaveLength(2);
    expect(p.inner).toHaveLength(1);
    const req = p.inner[0];
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe('/ingest');
    expect(req?.headers.host).toBe(RELAY_HOST);
    expectNoAuth(req?.headers ?? {});
    const event = OfficeEventSchema.parse(JSON.parse(req?.body ?? 'null'));
    expect(event).toMatchObject({ source: 'cloud', remoteSessionId: REMOTE, kind: 'prompt.submit' });
  });

  it('the child gets the same stdin bytes (the event id is the same as a direct send)', async () => {
    const direct = await relay();
    await runEmit(SESSION_START, { CLAUDE_CODE_REMOTE_SESSION_ID: REMOTE, AGENT_OFFICE_RELAY_URL: `http://127.0.0.1:${direct.port}` });
    // Through re-exec: the child sends straight to the loopback relay (Node never proxies loopback).
    const via = await relay();
    const p = await proxy();
    const pr = probe();
    await runEmit(SESSION_START, { ...pr.env, CLAUDE_CODE_REMOTE_SESSION_ID: REMOTE, AGENT_OFFICE_RELAY_URL: `http://127.0.0.1:${via.port}`, HTTPS_PROXY: p.url });
    expect(pr.lines()).toHaveLength(2);
    expect(via.requests).toHaveLength(1);
    const id = (s: Seen | undefined): unknown => (JSON.parse(s?.body ?? 'null') as { id?: unknown }).id;
    expect(id(via.requests[0])).toBe(id(direct.requests[0]));
  });
});

describe('A3.1 AC2: no loop', () => {
  it.each([
    ['marker "1"', '1'],
    ['marker empty', ''],
  ])('%s, flag unset (as if Node ignored it) -> no re-exec, sends directly', async (_n, marker) => {
    const r0 = await relay();
    const p = await proxy();
    const pr = probe();
    const r = await runEmit(PO_PROMPT, {
      ...pr.env,
      CLAUDE_CODE_REMOTE_SESSION_ID: REMOTE,
      AGENT_OFFICE_RELAY_URL: `http://127.0.0.1:${r0.port}`,
      HTTPS_PROXY: p.url,
      AGENT_OFFICE_EMIT_REEXEC: marker,
    });
    expectSilent(r);
    expect(pr.lines()).toHaveLength(1);
    expect(r0.requests).toHaveLength(1);
    expect(p.connects).toEqual([]);
  });

  it('NODE_USE_ENV_PROXY=1 already -> no child; this process itself goes through the proxy', async () => {
    const p = await proxy();
    const pr = probe();
    const r = await runEmit(PO_PROMPT, cloudBehindProxy(p, { ...pr.env, NODE_USE_ENV_PROXY: '1' }));
    // Node prints its "EnvHttpProxyAgent is experimental" warning at startup, before any script code runs,
    // so emit cannot mute it when the flag comes from outside (tester L-1, accepted; exit 0 and stdout stay clean).
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(pr.lines()).toHaveLength(1);
    expect(p.connects.map((c) => c.target)).toEqual([`${RELAY_HOST}:443`]);
  });
});

describe('A3.1 AC3: PC, or cloud without a proxy -> no child (PC path unchanged)', () => {
  it('PC env with HTTPS_PROXY set -> one process, local bridge gets the event', async () => {
    const b = await bridge();
    const p = await proxy();
    const pr = probe();
    const r = await runEmit(PO_PROMPT, { ...pr.env, AGENT_OFFICE_HOME: dataDirWithToken(), AGENT_OFFICE_BRIDGE_PORT: String(b.port), HTTPS_PROXY: p.url });
    expectSilent(r);
    expect(pr.lines()).toHaveLength(1);
    expect(b.requests).toHaveLength(1);
    expect(p.connects).toEqual([]);
  });

  it('cloud without HTTPS_PROXY -> one process, relay gets the event directly', async () => {
    const r0 = await relay();
    const pr = probe();
    expectSilent(await runEmit(PO_PROMPT, { ...pr.env, CLAUDE_CODE_REMOTE_SESSION_ID: REMOTE, AGENT_OFFICE_RELAY_URL: `http://127.0.0.1:${r0.port}` }));
    expect(pr.lines()).toHaveLength(1);
    expect(r0.requests).toHaveLength(1);
  });

  it.each([
    ['no relay URL', undefined],
    ['a bad relay URL', 'http://relay.example.com'],
  ])('cloud + proxy but %s -> no child, nothing sent', async (_n, url) => {
    const p = await proxy();
    const pr = probe();
    const env: Record<string, string> = { ...pr.env, CLAUDE_CODE_REMOTE_SESSION_ID: REMOTE, HTTPS_PROXY: p.url };
    if (url !== undefined) env.AGENT_OFFICE_RELAY_URL = url;
    expectSilent(await runEmit(PO_PROMPT, env));
    expect(pr.lines()).toHaveLength(1);
    expect(p.connects).toEqual([]);
  });

  it('empty stdin -> no child', async () => {
    const p = await proxy();
    const pr = probe();
    expectSilent(await runEmit('', cloudBehindProxy(p, pr.env)));
    expect(pr.lines()).toHaveLength(1);
  });
});

describe('A3.1 AC4: a bad child never breaks the parent', () => {
  it('child crashes (prints to stdout and stderr, exits 3) -> parent exits 0, empty stdout and stderr', async () => {
    const p = await proxy();
    const pr = probe();
    const r = await runEmit(PO_PROMPT, cloudBehindProxy(p, { ...pr.env, AO_PROBE_CHILD: 'crash' }));
    expectSilent(r);
    expect(pr.lines()).toHaveLength(2);
    expect(p.connects).toEqual([]);
    expect(r.ms).toBeLessThan(6_000);
  });

  it('child hangs forever -> parent kills it and exits 0 within 6 s', async () => {
    const p = await proxy();
    const pr = probe();
    const r = await runEmit(PO_PROMPT, cloudBehindProxy(p, { ...pr.env, AO_PROBE_CHILD: 'hang' }));
    expectSilent(r);
    expect(r.ms).toBeLessThan(6_000);
    const child = pr.lines()[1];
    expect(child?.marker).toBe('1');
    // The child must not outlive the parent.
    const until = Date.now() + 1_000;
    while (child && alive(child.pid) && Date.now() < until) await new Promise((res) => setTimeout(res, 20));
    expect(child && alive(child.pid)).toBe(false);
  }, 15_000);

  it('child is slow (4 s before it starts) -> it still sends; parent exits 0 within 6 s', async () => {
    const p = await proxy();
    const pr = probe();
    const r = await runEmit(PO_PROMPT, cloudBehindProxy(p, { ...pr.env, AO_PROBE_CHILD: 'slow' }));
    expectSilent(r);
    expect(r.ms).toBeGreaterThanOrEqual(4_000);
    expect(r.ms).toBeLessThan(6_000);
    expect(p.connects.map((c) => c.target)).toEqual([`${RELAY_HOST}:443`]);
  }, 15_000);
});

describe('A3.1 AC5: one retry on 401 (cloud only)', () => {
  it('401 then 204 -> exactly 2 requests, the second about 1.5 s later, same body', async () => {
    const r0 = await relay([401, 204]);
    const r = await runEmit(SESSION_START, { CLAUDE_CODE_REMOTE_SESSION_ID: REMOTE, AGENT_OFFICE_RELAY_URL: `http://127.0.0.1:${r0.port}` });
    expectSilent(r);
    expect(r0.requests).toHaveLength(2);
    expect(r0.requests[1]?.body).toBe(r0.requests[0]?.body);
    const gap = (r0.times[1] ?? 0) - (r0.times[0] ?? 0);
    expect(gap).toBeGreaterThanOrEqual(1_400);
    expect(gap).toBeLessThan(3_000);
    for (const q of r0.requests) expectNoAuth(q.headers);
  });

  it('two 401s -> 2 requests, exit 0', async () => {
    const r0 = await relay([401, 401]);
    const r = await runEmit(SESSION_START, { CLAUDE_CODE_REMOTE_SESSION_ID: REMOTE, AGENT_OFFICE_RELAY_URL: `http://127.0.0.1:${r0.port}` });
    expectSilent(r);
    expect(r0.requests).toHaveLength(2);
    expect(r.ms).toBeLessThan(6_000);
  });

  it.each([204, 403, 500])('%i -> 1 request (only 401 is retried)', async (status) => {
    const r0 = await relay([status, 204]);
    expectSilent(await runEmit(SESSION_START, { CLAUDE_CODE_REMOTE_SESSION_ID: REMOTE, AGENT_OFFICE_RELAY_URL: `http://127.0.0.1:${r0.port}` }));
    expect(r0.requests).toHaveLength(1);
  });

  it('PC: a 401 from the bridge is not retried', async () => {
    const r0 = await relay([401, 204]);
    expectSilent(await runEmit(SESSION_START, { AGENT_OFFICE_HOME: dataDirWithToken(), AGENT_OFFICE_BRIDGE_PORT: String(r0.port) }));
    expect(r0.requests).toHaveLength(1);
  });

  it.skipIf(CERT === null)('through re-exec + TLS proxy: 401 then 204 -> 2 requests inside the tunnel, neither with Authorization', async () => {
    const p = await proxy({ tls: CERT ?? undefined, statuses: [401, 204] });
    const pr = probe();
    const r = await runEmit(SESSION_START, cloudBehindProxy(p, { ...pr.env, NODE_EXTRA_CA_CERTS: CERT?.certFile ?? '' }));
    expectSilent(r);
    expect(pr.lines()).toHaveLength(2);
    expect(p.inner).toHaveLength(2);
    for (const q of p.inner) expectNoAuth(q.headers);
    for (const c of p.connects) expectNoAuth(c.headers);
  });
});

describe('A3.1 AC6: the bundle holds no token', () => {
  it('passes the repo secret scan and names no ingest token variable', () => {
    const src = readFileSync(BUILT, 'utf8');
    // The repo scanner exits non-zero on any finding (execFileSync then throws).
    expect(() => execFileSync(process.execPath, [join(PKG, '..', '..', 'scripts', 'secret-scan.mjs'), BUILT], { stdio: 'pipe' })).not.toThrow();
    expect(src).not.toMatch(/INGEST_TOKEN/);
    // No header object anywhere sets Authorization (the only mentions are core's scrub rules).
    expect(src).not.toMatch(/headers\s*:\s*\{[^}]*authorization/i);
    expect(src).not.toMatch(/["']authorization["']\s*:/i);
  });
});
