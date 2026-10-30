// C-07 acceptance tests: the BUILT single file is spawned with real (observed)
// hook payloads on stdin and a local mock HTTP server. Cloud auth is PROVISIONAL
// (spike S1): the cloud tests only prove destination, body and "no credential".
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OfficeEventSchema, normalize, fingerprint, type OfficeEvent } from '@agent-office/core';
import {
  BUILT,
  LOCAL_HEADER_VALUE,
  buildEmit,
  closedPort,
  dataDirWithToken,
  fixture,
  installCopy,
  loadFixtureSet,
  mockServer,
  runEmit,
  tempDir,
  type Mock,
} from './helpers.js';

const PO_PROMPT = fixture('pc-desktop', '010-UserPromptSubmit-exec.json');
const BASH_FAIL = fixture('pc2', '010-PostToolUseFailure-Bash-exec.json');
const SESSION_START = fixture('pc2', '001-SessionStart-exec.json');

let mocks: Mock[] = [];
async function mock(mode: 'ok' | 'hang' | 'error' | 'redirect' = 'ok'): Promise<Mock> {
  const m = await mockServer(mode);
  mocks.push(m);
  return m;
}
afterEach(async () => {
  await Promise.all(mocks.map((m) => m.close()));
  mocks = [];
});

beforeAll(() => {
  buildEmit();
}, 60_000);

/** PC environment pointing at a mock bridge. */
function pcEnv(port: number, home = dataDirWithToken()): Record<string, string> {
  return { AGENT_OFFICE_HOME: home, AGENT_OFFICE_BRIDGE_PORT: String(port) };
}

function parsed(m: Mock, i = 0): OfficeEvent {
  return JSON.parse(m.requests[i]?.body ?? 'null') as OfficeEvent;
}

function expectSilentSuccess(r: { code: number | null; stdout: string; stderr: string }): void {
  expect(r.code).toBe(0);
  expect(r.stdout).toBe('');
  expect(r.stderr).toBe('');
}

describe('build', () => {
  it('is one file whose only imports are node: built-ins', () => {
    const src = readFileSync(BUILT, 'utf8');
    const specifiers = [...src.matchAll(/(?:^|\n)\s*import\b[^'"\n]*?from\s*["']([^"']+)["']|import\(["']([^"']+)["']\)|require\(["']([^"']+)["']\)/g)].map(
      (m) => m[1] ?? m[2] ?? m[3],
    );
    expect(specifiers.length).toBeGreaterThan(0);
    for (const s of specifiers) expect(s, String(s)).toMatch(/^node:/);
    expect(src).not.toMatch(/^#!/);
  });
});

describe('destination (FR-002)', () => {
  it('PC: POSTs to the local bridge path with the local token header and a valid OfficeEvent', async () => {
    const m = await mock();
    const r = await runEmit(PO_PROMPT, pcEnv(m.port));
    expectSilentSuccess(r);
    expect(m.requests).toHaveLength(1);
    const req = m.requests[0];
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe('/hooks/event');
    expect(req?.headers['x-agent-office-local']).toBe(LOCAL_HEADER_VALUE);
    expect(req?.headers['content-type']).toBe('application/json');
    expect(req?.headers.authorization).toBeUndefined();
    const e = parsed(m);
    expect(OfficeEventSchema.safeParse(e).success).toBe(true);
    expect(e).toMatchObject({ v: 1, source: 'local', kind: 'prompt.submit', repo: 'agent-office' });
    expect(e.remoteSessionId).toBeUndefined();
  });

  it('PC: the event is exactly what core.normalize gives for the same stdin (id = sha256(source + stdin))', async () => {
    const m = await mock();
    await runEmit(BASH_FAIL, pcEnv(m.port));
    const e = parsed(m);
    const id = await fingerprint('local', BASH_FAIL);
    expect(e.id).toBe(id);
    expect(e).toEqual(normalize(JSON.parse(BASH_FAIL), { id, emittedAt: e.emittedAt, source: 'local' }));
    expect(Math.abs(e.emittedAt - Date.now())).toBeLessThan(10_000);
  });

  it('PC: AGENT_OFFICE_RUN_ID becomes runId; a malformed one is dropped', async () => {
    const m = await mock();
    await runEmit(SESSION_START, { ...pcEnv(m.port), AGENT_OFFICE_RUN_ID: 'run_abc-1' });
    await runEmit(SESSION_START, { ...pcEnv(m.port), AGENT_OFFICE_RUN_ID: 'bad id; rm -rf /' });
    expect(parsed(m, 0).runId).toBe('run_abc-1');
    expect(parsed(m, 1).runId).toBeUndefined();
  });

  it('PC: no local token (or a malformed one) sends nothing and exits 0', async () => {
    const m = await mock();
    for (const home of [dataDirWithToken(null), dataDirWithToken('short'), dataDirWithToken('has spaces and !!! chars in it, long enough')]) {
      expectSilentSuccess(await runEmit(PO_PROMPT, pcEnv(m.port, home)));
    }
    expect(m.requests).toHaveLength(0);
  });

  it('PC: the host is always 127.0.0.1 (a relay URL in the environment is not used)', async () => {
    const bridge = await mock();
    const relay = await mock();
    await runEmit(PO_PROMPT, { ...pcEnv(bridge.port), AGENT_OFFICE_RELAY_URL: `http://127.0.0.1:${relay.port}` });
    expect(bridge.requests).toHaveLength(1);
    expect(relay.requests).toHaveLength(0);
  });

  it('cloud: CLAUDE_CODE_REMOTE_SESSION_ID set -> POST $AGENT_OFFICE_RELAY_URL/ingest, no credential from the script', async () => {
    const relay = await mock();
    const bridge = await mock();
    const r = await runEmit(PO_PROMPT, {
      ...pcEnv(bridge.port),
      CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_01ABCdef23',
      AGENT_OFFICE_RELAY_URL: `http://127.0.0.1:${relay.port}/`,
    });
    expectSilentSuccess(r);
    expect(bridge.requests).toHaveLength(0);
    expect(relay.requests).toHaveLength(1);
    const req = relay.requests[0];
    expect(req?.url).toBe('/ingest');
    expect(req?.headers.authorization).toBeUndefined();
    expect(req?.headers['x-agent-office-local']).toBeUndefined();
    expect(req?.body).not.toContain(LOCAL_HEADER_VALUE);
    expect(parsed(relay)).toMatchObject({ source: 'cloud', remoteSessionId: 'cse_01ABCdef23', kind: 'prompt.submit' });
  });

  it('cloud: a base path is kept (/relay -> /relay/ingest)', async () => {
    const relay = await mock();
    await runEmit(PO_PROMPT, { CLAUDE_CODE_REMOTE_SESSION_ID: 'session_X1', AGENT_OFFICE_RELAY_URL: `http://127.0.0.1:${relay.port}/relay/?x=1#f` });
    expect(relay.requests[0]?.url).toBe('/relay/ingest');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not a URL', 'not a url'],
    ['plain http to a public host', 'http://relay.example.com'],
    ['credentials in the URL', 'https://user:pw@relay.example.com'],
    ['other scheme', 'ftp://relay.example.com'],
    ['file scheme', 'file:///etc/passwd'],
  ])('cloud: relay URL %s -> nothing sent, exit 0, and no fallback to the local bridge', async (_n, url) => {
    const bridge = await mock();
    const env: Record<string, string> = { ...pcEnv(bridge.port), CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_1' };
    if (url !== undefined) env.AGENT_OFFICE_RELAY_URL = url;
    expectSilentSuccess(await runEmit(PO_PROMPT, env));
    expect(bridge.requests).toHaveLength(0);
  });

  it('an empty CLAUDE_CODE_REMOTE_SESSION_ID counts as not set (PC destination)', async () => {
    const m = await mock();
    await runEmit(PO_PROMPT, { ...pcEnv(m.port), CLAUDE_CODE_REMOTE_SESSION_ID: '' });
    expect(m.requests).toHaveLength(1);
  });

  it('a malformed remote session id is dropped from the event (the event is still sent)', async () => {
    const relay = await mock();
    await runEmit(PO_PROMPT, { CLAUDE_CODE_REMOTE_SESSION_ID: 'not-a-remote-id', AGENT_OFFICE_RELAY_URL: `http://127.0.0.1:${relay.port}` });
    expect(relay.requests).toHaveLength(1);
    expect(parsed(relay).remoteSessionId).toBeUndefined();
  });
});

describe('failure modes (FR-003): always exit 0, empty stdout', () => {
  it('server down', async () => {
    const port = await closedPort();
    const r = await runEmit(PO_PROMPT, pcEnv(port));
    expectSilentSuccess(r);
    expect(r.ms).toBeLessThan(3_000);
  });

  it('server accepts but never answers: gives up after 3 s', async () => {
    const m = await mock('hang');
    const r = await runEmit(PO_PROMPT, pcEnv(m.port));
    expectSilentSuccess(r);
    expect(m.requests).toHaveLength(1);
    expect(r.ms).toBeGreaterThanOrEqual(2_800);
    expect(r.ms).toBeLessThan(5_500);
  }, 15_000);

  it('server answers 500: exit 0, one attempt, no retry', async () => {
    const m = await mock('error');
    expectSilentSuccess(await runEmit(PO_PROMPT, pcEnv(m.port)));
    expect(m.requests).toHaveLength(1);
  });

  it('server answers a redirect: not followed, exit 0', async () => {
    const m = await mock('redirect');
    expectSilentSuccess(await runEmit(PO_PROMPT, pcEnv(m.port)));
    expect(m.requests.map((r) => r.url)).toEqual(['/hooks/event']);
  });

  it.each([
    ['empty stdin', ''],
    ['not JSON', 'this is not json'],
    ['truncated JSON', '{"hook_event_name":"PreToolUse","session_id":"s1"'],
    ['JSON array', '[1,2,3]'],
    ['JSON string', '"PreToolUse"'],
    ['JSON null', 'null'],
    ['number', '42'],
    ['binary junk', '\u0000\u0001\u0002￿'],
    ['object without a hook name', '{"session_id":"s1"}'],
    ['unknown hook event', '{"hook_event_name":"PreCompact","session_id":"s1","cwd":"/x/y"}'],
    ['hook event without session id', '{"hook_event_name":"Stop"}'],
    ['tool event without a tool name', '{"hook_event_name":"PreToolUse","session_id":"s1"}'],
    ['__proto__ hook name', '{"hook_event_name":"__proto__","session_id":"s1"}'],
  ])('malformed or unusable stdin (%s): nothing sent', async (_n, stdin) => {
    const m = await mock();
    expectSilentSuccess(await runEmit(stdin, pcEnv(m.port)));
    expect(m.requests).toHaveLength(0);
  });

  it('empty-type SubagentStop (observed internal helper) is not sent', async () => {
    const m = await mock();
    expectSilentSuccess(await runEmit(fixture('pc2', '012-SubagentStop-exec.json'), pcEnv(m.port)));
    expect(m.requests).toHaveLength(0);
  });

  it('stdin that never closes: gives up after about 2 s, exit 0', async () => {
    const { spawn } = await import('node:child_process');
    const m = await mock();
    const t0 = Date.now();
    const child = spawn(process.execPath, [BUILT], { env: { PATH: process.env.PATH ?? '', ...pcEnv(m.port) }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.write('{"hook_event_name":"Stop"');
    const code = await new Promise<number | null>((r) => child.on('close', r));
    expect(code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(m.requests).toHaveLength(0);
  }, 15_000);

  it('an oversized payload (over 8 MiB) is ignored, not half-parsed', async () => {
    const m = await mock();
    const big = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'x'.repeat(9 * 1024 * 1024) });
    expectSilentSuccess(await runEmit(big, pcEnv(m.port)));
    expect(m.requests).toHaveLength(0);
  }, 30_000);
});

describe('body never carries raw input (plan §11 redaction)', () => {
  const secretBash = JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    cwd: '/home/user/secret-project/sub',
    transcript_path: '/home/user/.claude/projects/x/abc.jsonl',
    tool_name: 'Bash',
    tool_use_id: 'toolu_1',
    tool_input: { command: 'curl -H "Authorization: Bearer abcdef1234567890" https://x.example/ && echo hunter2' },
    tool_response: { stdout: 'FILE CONTENT MUST NOT LEAVE' },
  });

  it('no tool_input, tool_response, transcript path or full cwd; only summaries', async () => {
    const m = await mock();
    await runEmit(secretBash, pcEnv(m.port));
    const body = m.requests[0]?.body ?? '';
    expect(body).not.toMatch(/tool_input|tool_response|transcript|"cwd"/);
    expect(body).not.toMatch(/Bearer|abcdef1234567890|hunter2|FILE CONTENT|\/home\/user|x\.example/);
    expect(parsed(m)).toMatchObject({ repo: 'sub', tool: { name: 'Bash', summary: 'curl -H' } });
  });

  it('a planted secret in a prompt is scrubbed before sending', async () => {
    const m = await mock();
    const key = ['sk', 'ant', 'api03-ABCDEFGHIJKLMNOPQRSTUVWX'].join('-');
    await runEmit(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/a/b', prompt: `use ${key} and password=hunter2` }), pcEnv(m.port));
    const body = m.requests[0]?.body ?? '';
    expect(body).not.toContain(key);
    expect(body).not.toContain('hunter2');
    expect(parsed(m).text).toContain('[redacted]');
  });

  it('system prompts (hand-back, task notification, side-session brief) send only their marker', async () => {
    const m = await mock();
    for (const prefix of ['<agent-message from="a1">\nREPORT BODY', '<task-notification>\nTASK BODY', 'Background (from the session that started this one):\nBRIEF BODY']) {
      await runEmit(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/a/b', prompt: prefix }), pcEnv(m.port));
    }
    expect(m.requests.map((r) => (JSON.parse(r.body) as OfficeEvent).text)).toEqual([
      '<agent-message',
      '<task-notification',
      'Background (from the session that started this one)',
    ]);
    expect(m.requests.map((r) => r.body).join('')).not.toMatch(/BODY/);
  });

  it('SubagentHandback sends no report text', async () => {
    const m = await mock();
    const fx = fixture('pc', '019-PreToolUse-SubagentHandback-architect-exec.json');
    const report = (JSON.parse(fx) as { tool_input: { message: string } }).tool_input.message;
    await runEmit(fx, pcEnv(m.port));
    expect(parsed(m).tool).toMatchObject({ name: 'SubagentHandback', summary: '' });
    expect(m.requests[0]?.body).not.toContain(report.slice(0, 20));
  });

  it('every request body is within the 64 KB event limit and parses as an OfficeEvent', async () => {
    const m = await mock();
    const huge = JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', cwd: '/a/b', last_assistant_message: 'word '.repeat(200_000) });
    await runEmit(huge, pcEnv(m.port));
    const req = m.requests[0];
    expect(req).toBeDefined();
    expect(Buffer.byteLength(req?.body ?? '')).toBeLessThan(64 * 1024);
    expect(OfficeEventSchema.safeParse(parsed(m)).success).toBe(true);
    expect(parsed(m).text?.length).toBeLessThanOrEqual(500);
  });
});

describe('observed sessions: one request per recognised event', () => {
  it.each(['pc2', 'pc-desktop'])('%s', async (set) => {
    const m = await mock();
    const env = pcEnv(m.port);
    const files = loadFixtureSet(set);
    let expected = 0;
    for (const f of files) {
      const raw = JSON.stringify(f.payload);
      const id = await fingerprint('local', raw);
      if (normalize(f.payload, { id, emittedAt: 1, source: 'local' })) expected += 1;
      expectSilentSuccess(await runEmit(raw, env));
    }
    expect(expected).toBeGreaterThan(8);
    expect(m.requests).toHaveLength(expected);
    for (const r of m.requests) expect(OfficeEventSchema.safeParse(JSON.parse(r.body)).success).toBe(true);
  }, 60_000);
});

describe('A2.3: the built hook mixes a random nonce into PermissionRequest / Notification ids only', () => {
  it('the same PermissionRequest and Notification twice -> 4 requests, 2 + 2 distinct ids; PreToolUse twice -> same id', async () => {
    const m = await mock();
    const env = pcEnv(m.port);
    const perm = fixture('pc2', '008-PermissionRequest-Bash-exec.json');
    const note = fixture('pc2', '009-Notification-exec.json');
    const pre = fixture('pc2', '005-PreToolUse-Bash-exec.json');
    for (const raw of [perm, perm, note, note, pre, pre]) expectSilentSuccess(await runEmit(raw, env));
    const ids = m.requests.map((r) => (JSON.parse(r.body) as OfficeEvent).id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids.slice(0, 2)).size).toBe(2);
    expect(new Set(ids.slice(2, 4)).size).toBe(2);
    expect(ids[4]).toBe(ids[5]);
    expect(ids[4]).toBe(await fingerprint('local', pre));
    const e = parsed(m, 0);
    expect(e.permission?.requestId).toBe(e.id);
  }, 30_000);
});

describe('repo copy wins over the user copy (FR-004)', () => {
  const REPO_REL = join('.claude', 'hooks', 'agent-office-emit.mjs');

  it('the user copy exits without sending when the repo has its own copy', async () => {
    const m = await mock();
    const project = tempDir('ao-proj-');
    installCopy(project, REPO_REL);
    const userCopy = installCopy(tempDir('ao-user-'), join('.agent-office', 'agent-office-emit.mjs'));
    const r = await runEmit(PO_PROMPT, { ...pcEnv(m.port), CLAUDE_PROJECT_DIR: project }, userCopy);
    expectSilentSuccess(r);
    expect(m.requests).toHaveLength(0);
  });

  it('the repo copy itself sends', async () => {
    const m = await mock();
    const project = tempDir('ao-proj-');
    const repoCopy = installCopy(project, REPO_REL);
    expectSilentSuccess(await runEmit(PO_PROMPT, { ...pcEnv(m.port), CLAUDE_PROJECT_DIR: project }, repoCopy));
    expect(m.requests).toHaveLength(1);
  });

  it('the user copy sends when the repo has no copy, or CLAUDE_PROJECT_DIR is unset', async () => {
    const m = await mock();
    const userCopy = installCopy(tempDir('ao-user-'), join('.agent-office', 'agent-office-emit.mjs'));
    await runEmit(PO_PROMPT, { ...pcEnv(m.port), CLAUDE_PROJECT_DIR: tempDir('ao-proj-') }, userCopy);
    await runEmit(PO_PROMPT, pcEnv(m.port), userCopy);
    expect(m.requests).toHaveLength(2);
  });

  it('both hooks configured: exactly one event arrives', async () => {
    const m = await mock();
    const project = tempDir('ao-proj-');
    const repoCopy = installCopy(project, REPO_REL);
    const userCopy = installCopy(tempDir('ao-user-'), join('.agent-office', 'agent-office-emit.mjs'));
    const env = { ...pcEnv(m.port), CLAUDE_PROJECT_DIR: project };
    await Promise.all([runEmit(PO_PROMPT, env, repoCopy), runEmit(PO_PROMPT, env, userCopy)]);
    expect(m.requests).toHaveLength(1);
  });
});
