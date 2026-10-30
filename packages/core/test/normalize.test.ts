import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fingerprint } from '../src/fingerprint.js';
import { normalize, type NormalizeContext } from '../src/normalize.js';
import { REDACTED, REDACTED_ID } from '../src/redact.js';
import { MAX_TEXT } from '../src/schema.js';
import { ACTIVITIES, toolActivity } from '../src/toolActivity.js';

const ctx: NormalizeContext = { id: 'b'.repeat(64), emittedAt: 1000, source: 'local' };
const base = { session_id: 's1', cwd: '/home/user/proj' };
const j = (...p: string[]) => p.join('');

describe('fingerprint', () => {
  it('is sha256(source + raw) in lowercase hex', async () => {
    const raw = '{"a":1}';
    const expected = createHash('sha256').update(`local${raw}`).digest('hex');
    expect(await fingerprint('local', raw)).toBe(expected);
  });

  it('same input -> same id; different source -> different id', async () => {
    const raw = '{"hook_event_name":"Stop"}';
    expect(await fingerprint('cloud', raw)).toBe(await fingerprint('cloud', raw));
    expect(await fingerprint('cloud', raw)).not.toBe(await fingerprint('local', raw));
  });

  it('handles unicode', async () => {
    const id = await fingerprint('local', 'héllo 😀');
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).toBe(createHash('sha256').update('localhéllo 😀', 'utf8').digest('hex'));
  });
});

describe('toolActivity (FR-008)', () => {
  it.each([
    ['Read', 'reading'],
    ['Glob', 'reading'],
    ['Grep', 'reading'],
    ['Edit', 'typing'],
    ['Write', 'typing'],
    ['NotebookEdit', 'typing'],
    ['Bash', 'running'],
    ['PowerShell', 'running'],
    ['WebFetch', 'browsing'],
    ['WebSearch', 'browsing'],
    ['Agent', 'delegating'],
    ['Task', 'delegating'],
    ['mcp__memory__x', 'working'],
    ['TodoWrite', 'working'],
    ['constructor', 'working'],
    ['__proto__', 'working'],
  ])('%s -> %s', (tool, activity) => {
    expect(toolActivity(tool)).toBe(activity);
    expect(ACTIVITIES).toContain(activity);
  });
});

describe('normalize: rejects what is not ours', () => {
  it.each([
    ['null', null],
    ['string', 'x'],
    ['array', []],
    ['no hook name', { ...base }],
    ['unknown hook', { ...base, hook_event_name: 'PreCompact' }],
    ['prototype key as hook', { ...base, hook_event_name: 'toString' }],
    ['no session id', { hook_event_name: 'Stop' }],
    ['empty session id', { hook_event_name: 'Stop', session_id: '' }],
    ['tool event without tool_name', { ...base, hook_event_name: 'PreToolUse' }],
    ['permission without tool_name', { ...base, hook_event_name: 'PermissionRequest' }],
    ['SubagentStart without agent_type', { ...base, hook_event_name: 'SubagentStart', agent_id: 'a' }],
    ['SubagentStop with empty agent_type', { ...base, hook_event_name: 'SubagentStop', agent_type: '' }],
    ['session id with unsafe chars', { hook_event_name: 'Stop', session_id: '../../etc' }],
  ])('%s -> null', (_n, raw) => {
    expect(normalize(raw, ctx)).toBeNull();
  });
});

describe('normalize: context and fields', () => {
  it('copies valid remoteSessionId and runId, drops malformed ones', () => {
    const raw = { ...base, hook_event_name: 'Stop' };
    const ok = normalize(raw, { ...ctx, source: 'cloud', remoteSessionId: 'cse_01ABC', runId: 'run_1' });
    expect(ok).toMatchObject({ source: 'cloud', remoteSessionId: 'cse_01ABC', runId: 'run_1' });
    const bad = normalize(raw, { ...ctx, remoteSessionId: 'cse_../x', runId: 'a b' });
    expect(bad).not.toBeNull();
    expect(bad).not.toHaveProperty('remoteSessionId');
    expect(bad).not.toHaveProperty('runId');
  });

  it('has no undefined-valued keys', () => {
    const ev = normalize({ hook_event_name: 'SessionEnd', session_id: 's' }, ctx);
    expect(ev).toEqual({ v: 1, id: ctx.id, emittedAt: 1000, source: 'local', sessionId: 's', actor: { kind: 'main', agentType: null, agentId: null }, kind: 'session.end' });
  });

  it('empty agent_type on a tool event means main', () => {
    const ev = normalize({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', agent_type: '' }, ctx);
    expect(ev?.actor).toEqual({ kind: 'main', agentType: null, agentId: null });
  });

  it('subagent without agent_id gets agentId null', () => {
    const ev = normalize({ ...base, hook_event_name: 'SubagentStart', agent_type: 'coder' }, ctx);
    expect(ev?.actor).toEqual({ kind: 'subagent', agentType: 'coder', agentId: null });
  });

  it('scrubs and caps free text', () => {
    const secret = j('sk-', 'ant-api03-', 'abcdefghijklmnopqrstuvwxyz012345');
    const ev = normalize({ ...base, hook_event_name: 'UserPromptSubmit', prompt: `use ${secret} ${'x'.repeat(900)}` }, ctx);
    expect(ev?.text).toContain(REDACTED);
    expect(ev?.text).not.toContain('api03');
    expect(ev?.text?.length).toBeLessThanOrEqual(MAX_TEXT);
  });

  it('tool.fail keeps only a bare "Exit code N" first line', () => {
    const t = (error: unknown) =>
      normalize({ ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: {}, error }, ctx)?.text;
    expect(t('Exit code 2\nsecret output')).toBe('Exit code 2');
    expect(t('Command failed: cat /etc/passwd')).toBeUndefined();
    expect(t(42)).toBeUndefined();
  });

  it('turn.error uses whatever parts exist', () => {
    const t = (extra: object) => normalize({ ...base, hook_event_name: 'StopFailure', ...extra }, ctx)?.text;
    expect(t({ error: 'overloaded' })).toBe('overloaded');
    expect(t({})).toBeUndefined();
  });

  it('duration_ms is rounded; invalid durations are dropped', () => {
    const d = (duration_ms: unknown) =>
      normalize({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {}, duration_ms }, ctx)?.tool?.durationMs;
    expect(d(12.6)).toBe(13);
    expect(d(-1)).toBeUndefined();
    expect(d('5')).toBeUndefined();
    expect(d(Number.NaN)).toBeUndefined();
  });

  it('permission.request uses the event id as requestId', () => {
    const ev = normalize({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'git push --force' } }, ctx);
    expect(ev?.permission).toEqual({ requestId: ctx.id, toolName: 'Bash', summary: 'git push' });
  });

  it('missing cwd -> no repo', () => {
    const ev = normalize({ hook_event_name: 'Stop', session_id: 's' }, ctx);
    expect(ev).not.toHaveProperty('repo');
  });
});

describe('BUG-07: overlong names and ids are cut, not dropped; names are scrubbed', () => {
  const tok = j('gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8');
  it('long session_id, agent_type, agent_id, tool_name, tool_use_id', () => {
    const e = normalize(
      {
        ...base,
        hook_event_name: 'PreToolUse',
        session_id: 's'.repeat(300),
        agent_type: 'x'.repeat(150),
        agent_id: 'i'.repeat(300),
        tool_name: 'm'.repeat(300),
        tool_use_id: 'u'.repeat(300),
        tool_input: {},
      },
      ctx,
    );
    expect(e).not.toBeNull();
    expect(e?.sessionId).toBe('s'.repeat(200));
    expect(e?.actor.agentType).toHaveLength(100);
    expect(e?.actor.agentType?.endsWith('…')).toBe(true);
    expect(e?.actor.agentId).toBe('i'.repeat(200));
    expect(e?.tool?.name).toHaveLength(200);
    expect(e?.tool?.useId).toBe('u'.repeat(200));
  });

  it('secrets in agent_type and tool_name are redacted; controls stripped', () => {
    const e = normalize({ ...base, hook_event_name: 'PreToolUse', agent_type: `a\u202e${tok}`, tool_name: `mcp__x__${tok}`, tool_input: {} }, ctx);
    expect(JSON.stringify(e)).not.toContain('a1B2c3D4e5');
    expect(e?.actor.agentType).toBe(REDACTED); // "a" + token is one long run
    expect(e?.tool?.name).toBe(`mcp__x__${REDACTED}`);
    const mcp = 'mcp__plugin_ec2__DescribeInstancesInRegion2';
    expect(normalize({ ...base, hook_event_name: 'PreToolUse', tool_name: mcp, tool_input: {} }, ctx)?.tool?.name).toBe(mcp);
    const p = normalize({ ...base, hook_event_name: 'PermissionRequest', tool_name: tok, tool_input: {} }, ctx);
    expect(p?.permission?.toolName).toBe(REDACTED);
  });

  it('an agent_type of only invisible characters is still a subagent', () => {
    const e = normalize({ ...base, hook_event_name: 'SubagentStart', agent_type: '\u202e\u0007' }, ctx);
    expect(e?.actor).toEqual({ kind: 'subagent', agentType: 'unknown', agentId: null });
  });

  it('BUG-08: repo from a cwd of "..", control chars or bidi is safe or absent', () => {
    expect(normalize({ ...base, hook_event_name: 'Stop', cwd: '/x/..' }, ctx)?.repo).toBeUndefined();
    expect(normalize({ ...base, hook_event_name: 'Stop', cwd: '/x/a\nb\u202ec' }, ctx)?.repo).toBe('abc');
    expect(normalize({ ...base, hook_event_name: 'Stop', cwd: 'C:\\Users\\me\\My Project' }, ctx)?.repo).toBe('My Project');
  });
});

describe('normalize: ids (B-09) and real cloud id shapes', () => {
  const gh = j('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0');

  it('a cloud payload (UUID session_id, cse_ remote id) keeps both ids unchanged', () => {
    const ev = normalize(
      { session_id: '7c1d0e52-3b8f-4a5e-9d21-0f6b2a9c4e17', cwd: '/home/user/agent-office', hook_event_name: 'SessionStart' },
      { ...ctx, source: 'cloud', remoteSessionId: 'cse_01AbCdEfGhIjKlMnOpQrStUv' },
    );
    expect(ev).toMatchObject({
      source: 'cloud',
      sessionId: '7c1d0e52-3b8f-4a5e-9d21-0f6b2a9c4e17',
      remoteSessionId: 'cse_01AbCdEfGhIjKlMnOpQrStUv',
    });
  });

  it('session_id, agent_id and tool_use_id holding a secret shape become the stand-in', () => {
    const ev = normalize(
      { ...base, session_id: `s-${gh}`, hook_event_name: 'PreToolUse', tool_name: 'Read', agent_type: 'coder', agent_id: `a-${gh}`, tool_use_id: j('pass', 'word=x') },
      ctx,
    );
    expect(ev).toMatchObject({ sessionId: REDACTED_ID, actor: { agentId: REDACTED_ID }, tool: { useId: REDACTED_ID } });
    expect(JSON.stringify(ev)).not.toContain('A1b2C3d4');
  });

  it('a runId holding a secret shape is dropped (its schema allows "_", so a token fits)', () => {
    const ev = normalize({ ...base, hook_event_name: 'Stop' }, { ...ctx, runId: gh });
    expect(ev).not.toBeNull();
    expect(ev).not.toHaveProperty('runId');
  });
});
