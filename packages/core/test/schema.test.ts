import { describe, expect, it } from 'vitest';
import {
  CommandSchema,
  MAX_PROMPT,
  MAX_SUMMARY,
  MAX_TEXT,
  OfficeEventSchema,
  type Command,
  type OfficeEvent,
} from '../src/schema.js';

const ID = 'a'.repeat(64);

function event(over: Partial<OfficeEvent> = {}): OfficeEvent {
  return {
    v: 1,
    id: ID,
    emittedAt: 1_700_000_000_000,
    source: 'local',
    sessionId: 'abc123',
    actor: { kind: 'main', agentType: null, agentId: null },
    kind: 'session.start',
    ...over,
  };
}

describe('OfficeEventSchema: valid samples', () => {
  const valid: [string, OfficeEvent][] = [
    ['minimal session.start', event()],
    ['cloud with remote id and repo', event({ source: 'cloud', remoteSessionId: 'cse_01ABCdef', repo: 'portfolio' })],
    ['uuid session id, repo with space and accent', event({ sessionId: '123e4567-e89b-12d3-a456-426614174000', repo: 'Mon Projet é' })],
    ['bridge run id', event({ runId: 'run_01-abc' })],
    [
      'subagent tool.start',
      event({
        kind: 'tool.start',
        actor: { kind: 'subagent', agentType: 'coder', agentId: 'agent-1' },
        tool: { name: 'Edit', useId: 'toolu_1', summary: 'src/a.ts' },
      }),
    ],
    ['tool.end with duration', event({ kind: 'tool.end', tool: { name: 'Bash', summary: 'npm test', durationMs: 12 } })],
    ['prompt with max text', event({ kind: 'prompt.submit', text: 'x'.repeat(MAX_TEXT) })],
    [
      'permission.request',
      event({ kind: 'permission.request', permission: { requestId: 'req_1', toolName: 'Bash', summary: 'rm -rf' } }),
    ],
    [
      'permission.resolved',
      event({
        kind: 'permission.resolved',
        permission: { requestId: 'req_1', toolName: 'Bash', summary: '', decision: 'expired' },
      }),
    ],
    ['run.status', event({ kind: 'run.status', run: { status: 'exited', exitCode: 0 } })],
    ['receivedAt set', event({ receivedAt: 1_700_000_000_500 })],
  ];
  it.each(valid)('%s', (_name, e) => {
    expect(OfficeEventSchema.safeParse(e).success).toBe(true);
  });
});

describe('OfficeEventSchema: invalid samples', () => {
  const invalid: [string, unknown][] = [
    ['wrong version', { ...event(), v: 2 }],
    ['id not sha256 hex', event({ id: 'XYZ' })],
    ['uppercase hex id', event({ id: 'A'.repeat(64) })],
    ['negative emittedAt', event({ emittedAt: -1 })],
    ['fractional emittedAt', event({ emittedAt: 1.5 })],
    ['unknown source', { ...event(), source: 'mars' }],
    ['empty sessionId', event({ sessionId: '' })],
    ['unknown kind', { ...event(), kind: 'tool.explode' }],
    ['bad remote session id', event({ remoteSessionId: 'cse_../../x' })],
    ['repo is a path', event({ repo: 'C:\\Claude\\portfolio' })],
    ['repo with slash', event({ repo: 'a/b' })],
    // BUG-08
    ['repo ..', event({ repo: '..' })],
    ['repo .', event({ repo: '.' })],
    ['repo with newline', event({ repo: 'a\nb' })],
    ['repo with bidi override', event({ repo: 'a\u202eb' })],
    ['sessionId path traversal', event({ sessionId: '../../etc' })],
    ['sessionId with ..', event({ sessionId: 'a..b' })],
    ['sessionId with control chars', event({ sessionId: '\u0000\u202e' })],
    ['sessionId with space', event({ sessionId: 'a b' })],
    ['sessionId with colon', event({ sessionId: 'a:b' })],
    ['main with agentType', event({ actor: { kind: 'main', agentType: 'coder', agentId: null } })],
    ['subagent without agentType', event({ actor: { kind: 'subagent', agentType: null, agentId: 'x' } })],
    ['text too long', event({ kind: 'prompt.submit', text: 'x'.repeat(MAX_TEXT + 1) })],
    ['tool.start without tool', event({ kind: 'tool.start' })],
    ['tool summary too long', event({ kind: 'tool.start', tool: { name: 'Bash', summary: 'x'.repeat(MAX_SUMMARY + 1) } })],
    ['permission.request without permission', event({ kind: 'permission.request' })],
    [
      'permission.resolved without decision',
      event({ kind: 'permission.resolved', permission: { requestId: 'r', toolName: 'Bash', summary: '' } }),
    ],
    ['run.status without run', event({ kind: 'run.status' })],
    ['unknown extra field (raw tool_input smuggled in)', { ...event(), tool_input: { command: 'cat .env' } }],
    ['extra field inside tool', { ...event({ kind: 'tool.start' }), tool: { name: 'Bash', summary: '', input: {} } }],
    ['not an object', 'session.start'],
  ];
  it.each(invalid)('%s', (_name, e) => {
    expect(OfficeEventSchema.safeParse(e).success).toBe(false);
  });
});

describe('CommandSchema', () => {
  const valid: Command[] = [
    { type: 'run.start', target: 'local', repo: 'portfolio', prompt: 'hi' },
    { type: 'run.start', target: 'cloud', repo: 'agent-office', prompt: 'x'.repeat(MAX_PROMPT), mode: 'plan' },
    { type: 'run.stop', runId: 'run_1' },
    { type: 'run.message', runId: 'run_1', text: 'keep going' },
    { type: 'cloud.message', remoteSessionId: 'session_01ABC', text: 'status?' },
    { type: 'cloud.message', remoteSessionId: 'cse_01ABC', text: 'status?' },
    { type: 'permission.decide', requestId: 'req_1', decision: 'allow' },
    { type: 'permission.decide', requestId: 'req_1', decision: 'deny' },
  ];
  it.each(valid.map((c) => [c.type, c] as const))('accepts %s', (_t, c) => {
    expect(CommandSchema.safeParse(c).success).toBe(true);
  });

  const invalid: [string, unknown][] = [
    ['unknown type', { type: 'run.delete', runId: 'x' }],
    ['bypassPermissions mode', { type: 'run.start', target: 'local', repo: 'p', prompt: 'x', mode: 'bypassPermissions' }],
    ['auto mode', { type: 'run.start', target: 'local', repo: 'p', prompt: 'x', mode: 'auto' }],
    ['repo path traversal', { type: 'run.start', target: 'local', repo: '../etc', prompt: 'x' }],
    ['repo absolute path', { type: 'run.start', target: 'local', repo: 'C:\\Claude\\portfolio', prompt: 'x' }],
    ['empty prompt', { type: 'run.start', target: 'local', repo: 'p', prompt: '' }],
    ['prompt too long', { type: 'run.start', target: 'local', repo: 'p', prompt: 'x'.repeat(MAX_PROMPT + 1) }],
    ['unknown target', { type: 'run.start', target: 'mars', repo: 'p', prompt: 'x' }],
    ['runId with shell chars', { type: 'run.stop', runId: 'a;rm -rf /' }],
    ['cloud id wrong prefix', { type: 'cloud.message', remoteSessionId: 'sess_1', text: 'x' }],
    ['cloud id with flag injection', { type: 'cloud.message', remoteSessionId: 'session_1 --bare', text: 'x' }],
    ['decision expired is not a command', { type: 'permission.decide', requestId: 'r', decision: 'expired' }],
    ['mass assignment field', { type: 'run.stop', runId: 'r', actorEmail: 'x@y' }],
    ['missing field', { type: 'run.message', runId: 'r' }],
    // BUG-08
    ['whitespace-only prompt', { type: 'run.start', target: 'local', repo: 'portfolio', prompt: '   ' }],
    ['whitespace-only message', { type: 'run.message', runId: 'r', text: ' \n\t ' }],
    ['message that looks like a flag', { type: 'cloud.message', remoteSessionId: 'cse_abc', text: '--dangerously-skip-permissions' }],
    ['run message that looks like a flag', { type: 'run.message', runId: 'r', text: '  -p x' }],
    ['repo key with ..', { type: 'run.start', target: 'local', repo: 'a..', prompt: 'x' }],
    ['repo key ..', { type: 'run.start', target: 'local', repo: '..', prompt: 'x' }],
  ];
  it.each(invalid)('rejects %s', (_name, c) => {
    expect(CommandSchema.safeParse(c).success).toBe(false);
  });

  it('BUG-08: prompts and messages are trimmed', () => {
    const r = CommandSchema.safeParse({ type: 'run.message', runId: 'r', text: '  keep going \n' });
    expect(r.success && r.data.type === 'run.message' ? r.data.text : null).toBe('keep going');
    const p = CommandSchema.safeParse({ type: 'run.start', target: 'local', repo: 'p', prompt: '- a list item' });
    expect(p.success).toBe(true); // prompts go on stdin, so a leading "-" is fine there
  });
});
