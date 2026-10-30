// Contract tests: every hook fixture -> OfficeEvent.
// fixtures/hooks/{pc,pc2,pc-desktop} are OBSERVED (real captures, 2026-10-21,
// Windows, claude 2.1.306). fixtures/hooks/cloud is OBSERVED too (real cloud
// session, linux, 2026-10-25); it runs with source 'cloud' and a cse_ remote id
// (see fixtureContext). fixtures/hooks/provisional is PROVISIONAL – from docs,
// not observed – and stays for the events the observed sets do not cover.
import { describe, expect, it } from 'vitest';
import { fingerprint } from '../src/fingerprint.js';
import { HOOK_KIND, normalize } from '../src/normalize.js';
import { OfficeEventSchema, type OfficeEvent } from '../src/schema.js';
import { fixtureContext, loadFixtures, type HookFixture } from './helpers/fixtures.js';

const EMITTED_AT = 1_760_000_000_000;
const fixtures = loadFixtures();

async function run(f: HookFixture, payload: unknown = f.payload): Promise<OfficeEvent | null> {
  const ctx = fixtureContext(f.set);
  const id = await fingerprint(ctx.source, f.raw);
  return normalize(payload, { id, emittedAt: EMITTED_AT, ...ctx });
}

/** Fields normalize() reads. If a real payload stops carrying one, this fails. */
const REQUIRED_FIELDS: Record<string, string[]> = {
  _all: ['hook_event_name', 'session_id', 'cwd'],
  UserPromptSubmit: ['prompt'],
  PreToolUse: ['tool_name', 'tool_input', 'tool_use_id'],
  PostToolUse: ['tool_name', 'tool_input', 'tool_use_id'],
  PostToolUseFailure: ['tool_name', 'tool_input', 'tool_use_id', 'error'],
  PermissionRequest: ['tool_name', 'tool_input'],
  SubagentStart: ['agent_id', 'agent_type'],
  // last_assistant_message is optional: the observed CLI SubagentStop has none (S2).
  SubagentStop: ['agent_id', 'agent_type'],
  Stop: ['last_assistant_message'],
  StopFailure: ['error'],
  Notification: ['message'],
};

/** Expected results for the provisional set (null = must be ignored). */
const PROVISIONAL_EXPECT: Record<string, Partial<OfficeEvent> | null> = {
  '01-session-start.json': { kind: 'session.start', actor: { kind: 'main', agentType: null, agentId: null }, repo: 'my-project' },
  '02-user-prompt-submit.json': {
    kind: 'prompt.submit',
    text: 'Ask the architect to review the plan, then have the tester run the tests.',
  },
  '03-pre-tool-use-agent-main.json': {
    kind: 'tool.start',
    actor: { kind: 'main', agentType: null, agentId: null },
    tool: { name: 'Agent', useId: 'toolu_01AGENT', summary: 'architect: Review the build plan' },
  },
  '04-subagent-start-architect.json': {
    kind: 'agent.start',
    actor: { kind: 'subagent', agentType: 'architect', agentId: 'agent-arch01' },
  },
  '05-pre-tool-use-read-architect.json': {
    kind: 'tool.start',
    actor: { kind: 'subagent', agentType: 'architect', agentId: 'agent-arch01' },
    tool: { name: 'Read', useId: 'toolu_01READ', summary: 'docs/build-plan.md' },
  },
  '06-post-tool-use-read-architect.json': {
    kind: 'tool.end',
    tool: { name: 'Read', useId: 'toolu_01READ', summary: 'docs/build-plan.md', durationMs: 7 },
  },
  '07-pre-tool-use-grep-architect.json': { kind: 'tool.start', tool: { name: 'Grep', useId: 'toolu_01GREP', summary: 'DECISION REQUIRED' } },
  '08-pre-tool-use-glob-main.json': { kind: 'tool.start', tool: { name: 'Glob', useId: 'toolu_01GLOB', summary: 'packages/**/*.ts' } },
  '09-pre-tool-use-bash-tester.json': {
    kind: 'tool.start',
    actor: { kind: 'subagent', agentType: 'tester', agentId: 'agent-test01' },
    tool: { name: 'Bash', useId: 'toolu_01BASH', summary: 'npm test' },
  },
  '10-post-tool-use-failure-bash-tester.json': {
    kind: 'tool.fail',
    text: 'Exit code 1',
    tool: { name: 'Bash', useId: 'toolu_01BASH', summary: 'npm test', durationMs: 4187 },
  },
  '11-pre-tool-use-edit-coder-windows.json': {
    kind: 'tool.start',
    repo: 'portfolio',
    actor: { kind: 'subagent', agentType: 'coder', agentId: 'agent-code01' },
    tool: { name: 'Edit', useId: 'toolu_01EDIT', summary: 'data/about.ts' },
  },
  '12-pre-tool-use-write-coder.json': { kind: 'tool.start', tool: { name: 'Write', useId: 'toolu_01WRITE', summary: 'README.md' } },
  '13-pre-tool-use-webfetch.json': { kind: 'tool.start', tool: { name: 'WebFetch', useId: 'toolu_01FETCH', summary: 'code.claude.com' } },
  '14-pre-tool-use-websearch.json': {
    kind: 'tool.start',
    tool: { name: 'WebSearch', useId: 'toolu_01SEARCH', summary: 'pixijs isometric depth sorting' },
  },
  '15-pre-tool-use-mcp.json': { kind: 'tool.start', tool: { name: 'mcp__memory__create_entities', useId: 'toolu_01MCP', summary: '' } },
  '16-pre-tool-use-powershell.json': {
    kind: 'tool.start',
    repo: 'agent-office',
    tool: { name: 'PowerShell', useId: 'toolu_01PWSH', summary: 'Get-ChildItem -Recurse' },
  },
  '17-permission-request-bash.json': { kind: 'permission.request' },
  '18-notification-permission-prompt.json': { kind: 'notification', text: 'Claude needs your permission to use Bash' },
  '19-subagent-stop-architect.json': {
    kind: 'agent.stop',
    actor: { kind: 'subagent', agentType: 'architect', agentId: 'agent-arch01' },
    text: 'Plan reviewed. Found 3 open questions for the Product Owner.',
  },
  '20-subagent-start-explore.json': {
    kind: 'agent.start',
    actor: { kind: 'subagent', agentType: 'Explore', agentId: 'agent-expl01' },
  },
  '21-subagent-stop-internal-agent.json': null,
  '22-post-tool-use-agent-main.json': {
    kind: 'tool.end',
    actor: { kind: 'main', agentType: null, agentId: null },
    tool: { name: 'Agent', useId: 'toolu_01AGENT', summary: 'architect: Review the build plan', durationMs: 48230 },
  },
  '23-stop.json': { kind: 'turn.stop', text: 'Done. The architect reviewed the plan and the tester ran the suite.' },
  '24-stop-failure.json': { kind: 'turn.error', text: 'rate_limit: API Error: Rate limit reached' },
  '25-session-end.json': { kind: 'session.end' },
  '26-unknown-pre-compact.json': null,
};

const FORBIDDEN_IN_OUTPUT = [
  'MUST NOT LEAVE THE MACHINE',
  'file content',
  'replacement text',
  'original text',
  'transcript',
  '/home/user/my-project',
  'C:\\\\Claude',
  'rm -rf node_modules',
  'Review docs/build-plan.md and list open questions.',
  'permission_suggestions',
  // cloud tool_response bodies (V1-S2c tester L-1)
  'Spike S2: turn raw',
  'reference for Claude Code hooks',
];

/** Expected results for the OBSERVED sets, keyed "set/file" (null = must be ignored). Only the files worth pinning; the rest are snapshot-checked. */
const AGENT_OFFICE_MAIN = { kind: 'main', agentType: null, agentId: null } as const;
const OBSERVED_EXPECT: Record<string, object | null> = {
  'pc/001-SessionStart-exec.json': { kind: 'session.start', actor: AGENT_OFFICE_MAIN, repo: 'agent-office', source: 'local' },
  'pc/003-UserPromptSubmit-exec.json': { kind: 'prompt.submit', actor: AGENT_OFFICE_MAIN },
  'pc/005-PreToolUse-Agent-exec.json': {
    kind: 'tool.start',
    actor: AGENT_OFFICE_MAIN,
    tool: { name: 'Agent', useId: 'toolu_016tVbpAFkpwE2s4mGiKDCd1', summary: 'architect: Read README, grep decisions' },
  },
  'pc/006-PreToolUse-ToolSearch-exec.json': { kind: 'tool.start', tool: { name: 'ToolSearch', summary: 'select:WebFetch' } },
  'pc/008-SubagentStart-architect-exec.json': {
    kind: 'agent.start',
    actor: { kind: 'subagent', agentType: 'architect', agentId: 'a710a7da45c6a4ac1' },
  },
  'pc/010-PreToolUse-Read-architect-exec.json': {
    kind: 'tool.start',
    actor: { kind: 'subagent', agentType: 'architect', agentId: 'a710a7da45c6a4ac1' },
    tool: { name: 'Read', summary: 'README.md' },
  },
  'pc/019-PreToolUse-SubagentHandback-architect-exec.json': {
    kind: 'tool.start',
    actor: { kind: 'subagent', agentType: 'architect', agentId: 'a710a7da45c6a4ac1' },
    tool: { name: 'SubagentHandback', summary: '' },
  },
  'pc/021-SubagentStop-architect-exec.json': { kind: 'agent.stop', actor: { kind: 'subagent', agentType: 'architect', agentId: 'a710a7da45c6a4ac1' } },
  'pc/023-UserPromptSubmit-exec.json': { kind: 'prompt.submit', text: '<agent-message' },
  'pc/025-Stop-exec.json': { kind: 'turn.stop', actor: AGENT_OFFICE_MAIN, text: "Architect's done. Waiting on the tester." },
  'pc/026-SubagentStop-exec.json': null,
  'pc/034-SubagentStop-exec.json': null,
  'pc/035-SessionEnd-exec.json': { kind: 'session.end' },
  'pc2/008-PermissionRequest-Bash-exec.json': {
    kind: 'permission.request',
    actor: AGENT_OFFICE_MAIN,
    permission: { toolName: 'Bash', summary: 'node -e' },
  },
  'pc2/009-Notification-exec.json': { kind: 'notification', text: 'Claude needs your permission' },
  'pc2/010-PostToolUseFailure-Bash-exec.json': { kind: 'tool.fail', text: 'Exit code 3', tool: { name: 'Bash', summary: 'node -e', durationMs: 342 } },
  'pc2/012-SubagentStop-exec.json': null,
  'pc-desktop/005-UserPromptSubmit-exec.json': { kind: 'prompt.submit', text: 'Background (from the session that started this one)' },
  'pc-desktop/019-SubagentStop-architect-exec.json': { kind: 'agent.stop', actor: { kind: 'subagent', agentType: 'architect', agentId: 'a8c022657563c20d9' } },
  'pc-desktop/022-UserPromptSubmit-exec.json': { kind: 'prompt.submit', text: '<task-notification' },
  'pc-desktop/025-SubagentStop-exec.json': null,
  // Cloud (V1-S2c): same shapes as the PC, plus source 'cloud' and the cse_ remote id.
  'cloud/001-SessionStart-exec.json': { kind: 'session.start', actor: AGENT_OFFICE_MAIN, repo: 'agent-office', source: 'cloud' },
  'cloud/005-PreToolUse-Agent-exec.json': {
    kind: 'tool.start',
    actor: AGENT_OFFICE_MAIN,
    tool: { name: 'Agent', useId: 'toolu_01QSjyqhCSS3aE1dMdgd8X49', summary: 'architect: Read README, grep decisions' },
  },
  'cloud/007-PreToolUse-ToolSearch-exec.json': { kind: 'tool.start', actor: AGENT_OFFICE_MAIN, tool: { name: 'ToolSearch', summary: 'select:WebFetch' } },
  'cloud/008-PostToolUse-ToolSearch-exec.json': { kind: 'tool.end', tool: { name: 'ToolSearch', summary: 'select:WebFetch', durationMs: 4 } },
  'cloud/009-SubagentStart-architect-exec.json': { kind: 'agent.start', actor: { kind: 'subagent', agentType: 'architect', agentId: 'a1d0f42ffe7d14f60' } },
  'cloud/013-PreToolUse-Bash-tester-exec.json': {
    kind: 'tool.start',
    actor: { kind: 'subagent', agentType: 'tester', agentId: 'a198c2e5891746f5b' },
    tool: { name: 'Bash', summary: 'node --version;' },
  },
  'cloud/017-PreToolUse-SubagentHandback-tester-exec.json': {
    kind: 'tool.start',
    actor: { kind: 'subagent', agentType: 'tester', agentId: 'a198c2e5891746f5b' },
    tool: { name: 'SubagentHandback', summary: '' },
  },
  'cloud/020-SubagentStop-tester-exec.json': { kind: 'agent.stop', actor: { kind: 'subagent', agentType: 'tester', agentId: 'a198c2e5891746f5b' } },
  'cloud/025-UserPromptSubmit-shell.json': { kind: 'prompt.submit', text: '<agent-message' },
  'cloud/033-Stop-exec.json': { kind: 'turn.stop', actor: AGENT_OFFICE_MAIN },
  'cloud/034-SubagentStop-exec.json': null,
  'cloud/035-SessionEnd-exec.json': { kind: 'session.end' },
  'cloud/036-SessionStart-exec.json': { kind: 'session.start', actor: AGENT_OFFICE_MAIN },
  'cloud/038-UserPromptSubmit-exec.json': { kind: 'prompt.submit', text: '<task-notification' },
  'cloud/040-PreToolUse-ReadNotifications-exec.json': { kind: 'tool.start', actor: AGENT_OFFICE_MAIN, tool: { name: 'ReadNotifications', summary: '' } },
  'cloud/041-PostToolUse-ReadNotifications-exec.json': { kind: 'tool.end', tool: { name: 'ReadNotifications', summary: '', durationMs: 4 } },
};

describe('fixture inventory', () => {
  it('has at least one fixture for every FR-001 event', () => {
    const seen = new Set(fixtures.map((f) => f.payload.hook_event_name));
    for (const hook of Object.keys(HOOK_KIND)) expect(seen, hook).toContain(hook);
  });

  it('every provisional fixture is marked and has an expectation', () => {
    for (const f of fixtures.filter((x) => x.set === 'provisional')) {
      expect(f.provisional, f.file).toBe(true);
      expect(Object.hasOwn(PROVISIONAL_EXPECT, f.file), f.file).toBe(true);
    }
  });

  it('every observed fixture is marked observed, and every file named in OBSERVED_EXPECT exists', () => {
    for (const f of fixtures.filter((x) => x.set !== 'provisional')) expect(f.observed, `${f.set}/${f.file}`).toBe(true);
    const names = new Set(fixtures.map((f) => `${f.set}/${f.file}`));
    for (const k of Object.keys(OBSERVED_EXPECT)) expect(names, k).toContain(k);
  });

  it.each(fixtures.map((f) => [`${f.set}/${f.file}`, f] as const))('%s carries the fields normalize depends on', (_n, f) => {
    const hook = String(f.payload.hook_event_name);
    if (!Object.hasOwn(HOOK_KIND, hook)) return;
    for (const field of [...(REQUIRED_FIELDS._all ?? []), ...(REQUIRED_FIELDS[hook] ?? [])]) {
      expect(f.payload, `${f.file}: ${field}`).toHaveProperty([field]);
    }
  });
});

describe.each(fixtures.map((f) => [`${f.set}/${f.file}`, f] as const))('contract %s', (_name, f) => {
  it('normalizes to the expected OfficeEvent (or null)', async () => {
    const ev = await run(f);
    const expected = f.set === 'provisional' ? PROVISIONAL_EXPECT[f.file] : OBSERVED_EXPECT[`${f.set}/${f.file}`];
    if (expected === null) {
      expect(ev).toBeNull();
      return;
    }
    expect(ev).not.toBeNull();
    expect(OfficeEventSchema.safeParse(ev).success).toBe(true);
    if (expected) expect(ev).toMatchObject(expected);
    expect(ev).toMatchSnapshot();
  });

  it('never forwards raw tool_input, tool_response, transcript or full cwd', async () => {
    const ev = await run(f);
    const json = JSON.stringify(ev);
    for (const s of FORBIDDEN_IN_OUTPUT) expect(json).not.toContain(s);
    expect(json).not.toMatch(/tool_input|tool_response|transcript_path|"cwd"/);
  });

  it('is deterministic: same input twice -> identical event and id', async () => {
    const a = await run(f);
    const b = await run(f, JSON.parse(f.raw));
    expect(b).toEqual(a);
  });
});

// V1-S2c (plan A3.2): the OBSERVED cloud set (real cloud session, 2026-10-25).
describe('cloud fixtures (V1-S2c)', () => {
  const cloud = fixtures.filter((f) => f.set === 'cloud');
  const named = (f: HookFixture): [string, HookFixture] => [f.file, f];
  const env = (f: HookFixture): Record<string, boolean> => f.capture?.env ?? {};
  /** Same payload without `effort` (SessionStart/SubagentStart/prompts in cloud, and the PC CLI, do not send it). */
  const withoutEffort = (p: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'effort'));

  it('has all 46 observed captures, from linux, with the remote id set and cse_-shaped', () => {
    expect(cloud).toHaveLength(46);
    for (const f of cloud) {
      expect(f.observed, f.file).toBe(true);
      expect(f.capture?.platform, f.file).toBe('linux');
      expect(env(f).CLAUDE_CODE_REMOTE_SESSION_ID, f.file).toBe(true);
      expect(f.capture?.remoteSessionIdShape, f.file).toBe('cse_');
    }
  });

  it('covers every FR-001 event except PermissionRequest, Notification, PostToolUseFailure and StopFailure', () => {
    const seen = new Set(cloud.map((f) => String(f.payload.hook_event_name)));
    for (const h of ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop']) {
      expect(seen, h).toContain(h);
    }
    // Not seen in cloud: these stay PROVISIONAL for cloud (A3.2).
    for (const h of ['PermissionRequest', 'Notification', 'PostToolUseFailure', 'StopFailure']) expect(seen, h).not.toContain(h);
  });

  it('exec and shell hook forms both fire in cloud and give the same event', async () => {
    expect([...new Set(cloud.map((f) => f.capture?.form))].sort()).toEqual(['exec', 'shell']);
    const shell = cloud.filter((f) => f.capture?.form === 'shell');
    expect(shell.length).toBe(6);
    for (const s of shell) {
      const twin = cloud.find((f) => f.capture?.form === 'exec' && f.raw === s.raw);
      expect(twin, s.file).toBeDefined();
      if (twin) expect(await run(s), s.file).toEqual(await run(twin));
    }
  });

  it.each(cloud.map(named))('%s: null, or source cloud + sessionId = payload UUID + cse_ remoteSessionId', async (_n, f) => {
    const ev = await run(f);
    if (ev === null) return;
    expect(ev.source).toBe('cloud');
    expect(ev.sessionId).toBe(f.payload.session_id);
    expect(ev.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(ev.remoteSessionId).toMatch(/^cse_[A-Za-z0-9]+$/);
  });

  it('only the empty-agent_type SubagentStop is ignored (as on the PC)', async () => {
    const ignored: string[] = [];
    for (const f of cloud) if ((await run(f)) === null) ignored.push(f.file);
    expect(ignored).toEqual(['034-SubagentStop-exec.json']);
    expect(cloud.find((x) => x.file === '034-SubagentStop-exec.json')?.payload.agent_type).toBe('');
  });

  it.each(cloud.filter((f) => typeof f.payload.agent_type === 'string' && f.payload.agent_type !== '').map(named))(
    '%s: a subagent event is attributed to its subagent (as on the PC)',
    async (_n, f) => {
      const ev = await run(f);
      expect(ev?.actor).toEqual({ kind: 'subagent', agentType: f.payload.agent_type, agentId: f.payload.agent_id });
    },
  );

  it.each(cloud.filter((f) => ['SubagentHandback', 'ToolSearch', 'ReadNotifications'].includes(String(f.payload.tool_name))).map(named))(
    '%s: SubagentHandback/ToolSearch/ReadNotifications give a valid tool event or null, never a throw',
    async (_n, f) => {
      const ev = await run(f);
      if (ev === null) return;
      expect(OfficeEventSchema.safeParse(ev).success).toBe(true);
      expect(ev.kind).toMatch(/^tool\.(start|end)$/);
      expect(ev.tool?.name).toBe(f.payload.tool_name);
    },
  );

  it('the SubagentHandback report text and ReadNotifications content are never forwarded', async () => {
    for (const f of cloud.filter((x) => x.payload.tool_name === 'SubagentHandback' || x.payload.tool_name === 'ReadNotifications')) {
      const json = JSON.stringify(await run(f));
      for (const s of ['Nothing modifie', 'single-user visualizer', 'cross-session-message', 'notification_id']) expect(json, f.file).not.toContain(s);
    }
  });

  it('CLAUDE_EFFORT missing (SessionStart, SubagentStart, prompts) or the effort field absent changes nothing', async () => {
    const noEnv = cloud.filter((f) => env(f).CLAUDE_EFFORT === false);
    expect(new Set(noEnv.map((f) => String(f.payload.hook_event_name)))).toEqual(new Set(['SessionStart', 'SessionEnd', 'SubagentStart', 'UserPromptSubmit']));
    for (const f of noEnv) expect(await run(f), f.file).not.toBeNull();
    const withEffort = cloud.filter((x) => Object.hasOwn(x.payload, 'effort'));
    expect(withEffort.length).toBeGreaterThan(20);
    for (const f of withEffort) expect(await run(f, withoutEffort(f.payload)), f.file).toEqual(await run(f));
  });
});
