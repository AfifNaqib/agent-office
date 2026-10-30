// OfficeEvent v1 and the Command union (plan §7, §10). This is the contract shared
// by emit, bridge, relay and web. Changing it needs a version bump + architect review.
import { z } from 'zod';

export const MAX_TEXT = 500;
export const MAX_SUMMARY = 120;
export const MAX_PROMPT = 4000;
export const MAX_EVENT_BYTES = 64 * 1024;
export const MAX_COMMAND_BYTES = 8 * 1024;

/** agent_type values that own a desk in the office (FR-007). */
export const DESK_AGENTS = ['architect', 'coder', 'tester', 'manager'] as const;
export type DeskAgent = (typeof DESK_AGENTS)[number];

export const SOURCES = ['local', 'cloud'] as const;
export const EVENT_KINDS = [
  'session.start',
  'session.end',
  'prompt.submit',
  'agent.start',
  'agent.stop',
  'tool.start',
  'tool.end',
  'tool.fail',
  'permission.request',
  'permission.resolved',
  'notification',
  'turn.stop',
  'turn.error',
  'run.status',
] as const;
export const RUN_STATUSES = ['starting', 'running', 'exited', 'stopped', 'failed'] as const;
export const PERMISSION_DECISIONS = ['allow', 'deny', 'expired'] as const;
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan'] as const;

const nonNegInt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const SourceSchema = z.enum(SOURCES);
export const EventKindSchema = z.enum(EVENT_KINDS);
export const EventIdSchema = z.string().regex(/^[0-9a-f]{64}$/, 'sha256 hex');
export const RemoteSessionIdSchema = z.string().max(128).regex(/^(session|cse)_[A-Za-z0-9]+$/);
export const RunIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** Repo keys are allowlist lookups into the bridge config, never paths. No "..". */
export const RepoKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  .refine((s) => !s.includes('..'), 'no ".."');
/**
 * Hook session ids (UUIDs in practice). BUG-08: safe characters only, no "..",
 * no control characters, because the id is part of the relay's session key.
 */
export const SessionIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'safe characters only')
  .refine((s) => !s.includes('..'), 'no ".."');
/**
 * basename(cwd) for display. BUG-08: no path separators, C0/C1 controls or bidi
 * overrides, and never "." or "..". Other characters (spaces, accents) are real
 * folder names and allowed; the UI renders the value as a text node.
 */
export const RepoNameSchema = z
  .string()
  // eslint-disable-next-line no-control-regex
  .regex(/^[^/\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]{1,200}$/, 'basename only')
  .refine((s) => s !== '.' && s !== '..', 'not "." or ".."');
export const RequestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

export const ActorSchema = z
  .strictObject({
    kind: z.enum(['main', 'subagent']),
    agentType: z.string().min(1).max(100).nullable(),
    agentId: z.string().min(1).max(200).nullable(),
  })
  .refine((a) => (a.kind === 'main' ? a.agentType === null : a.agentType !== null), {
    message: 'main has no agentType; subagent requires one',
  });

export const ToolInfoSchema = z.strictObject({
  name: z.string().min(1).max(200),
  useId: z.string().min(1).max(200).optional(),
  summary: z.string().max(MAX_SUMMARY),
  durationMs: nonNegInt.optional(),
});

export const PermissionInfoSchema = z.strictObject({
  requestId: RequestIdSchema,
  toolName: z.string().min(1).max(200),
  summary: z.string().max(MAX_SUMMARY),
  decision: z.enum(PERMISSION_DECISIONS).optional(),
});

export const RunInfoSchema = z.strictObject({
  status: z.enum(RUN_STATUSES),
  exitCode: z.number().int().optional(),
});

const TOOL_KINDS = new Set(['tool.start', 'tool.end', 'tool.fail']);

export const OfficeEventSchema = z
  .strictObject({
    v: z.literal(1),
    id: EventIdSchema,
    emittedAt: nonNegInt,
    receivedAt: nonNegInt.optional(),
    source: SourceSchema,
    sessionId: SessionIdSchema,
    remoteSessionId: RemoteSessionIdSchema.optional(),
    runId: RunIdSchema.optional(),
    repo: RepoNameSchema.optional(),
    actor: ActorSchema,
    kind: EventKindSchema,
    tool: ToolInfoSchema.optional(),
    text: z.string().max(MAX_TEXT).optional(),
    permission: PermissionInfoSchema.optional(),
    run: RunInfoSchema.optional(),
  })
  .superRefine((e, ctx) => {
    if (TOOL_KINDS.has(e.kind) && !e.tool) {
      ctx.addIssue({ code: 'custom', path: ['tool'], message: `${e.kind} requires tool` });
    }
    if ((e.kind === 'permission.request' || e.kind === 'permission.resolved') && !e.permission) {
      ctx.addIssue({ code: 'custom', path: ['permission'], message: `${e.kind} requires permission` });
    }
    if (e.kind === 'permission.resolved' && e.permission && !e.permission.decision) {
      ctx.addIssue({ code: 'custom', path: ['permission', 'decision'], message: 'resolved requires decision' });
    }
    if (e.kind === 'run.status' && !e.run) {
      ctx.addIssue({ code: 'custom', path: ['run'], message: 'run.status requires run' });
    }
  });

export type Source = z.infer<typeof SourceSchema>;
export type EventKind = z.infer<typeof EventKindSchema>;
export type Actor = z.infer<typeof ActorSchema>;
export type ToolInfo = z.infer<typeof ToolInfoSchema>;
export type PermissionInfo = z.infer<typeof PermissionInfoSchema>;
export type RunInfo = z.infer<typeof RunInfoSchema>;
export type OfficeEvent = z.infer<typeof OfficeEventSchema>;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

// ---- Commands (plan §10), zod discriminated union, ≤ 8 KB on the wire ----

// BUG-08: trimmed, at least one visible character.
const promptText = z.string().trim().min(1).max(MAX_PROMPT);
/**
 * Message text must not start with "-", so it can never be read as a CLI flag.
 * V2 MUST still pass "--" before any positional text it gives a CLI, and keep
 * sending prompts on stdin (plan §11, MUST NOT 10).
 */
const messageText = promptText.refine((s) => !s.startsWith('-'), 'must not start with "-"');

export const RunStartCommandSchema = z.strictObject({
  type: z.literal('run.start'),
  target: z.enum(['local', 'cloud']),
  repo: RepoKeySchema,
  prompt: promptText,
  mode: z.enum(PERMISSION_MODES).optional(),
});
export const RunStopCommandSchema = z.strictObject({
  type: z.literal('run.stop'),
  runId: RunIdSchema,
});
export const RunMessageCommandSchema = z.strictObject({
  type: z.literal('run.message'),
  runId: RunIdSchema,
  text: messageText,
});
export const CloudMessageCommandSchema = z.strictObject({
  type: z.literal('cloud.message'),
  remoteSessionId: RemoteSessionIdSchema,
  text: messageText,
});
export const PermissionDecideCommandSchema = z.strictObject({
  type: z.literal('permission.decide'),
  requestId: RequestIdSchema,
  decision: z.enum(['allow', 'deny']),
});

export const CommandSchema = z.discriminatedUnion('type', [
  RunStartCommandSchema,
  RunStopCommandSchema,
  RunMessageCommandSchema,
  CloudMessageCommandSchema,
  PermissionDecideCommandSchema,
]);

export type Command = z.infer<typeof CommandSchema>;
export type CommandType = Command['type'];
