// normalize(raw, ctx): hook payload -> OfficeEvent v1 (FR-006, §7). Pure and
// deterministic. Only redacted summaries and capped text leave this function;
// tool_input, tool_response, transcript paths and the full cwd never do.
import { classifyPrompt, SYSTEM_PROMPT_MARKER } from './prompt.js';
import { cleanName, redactText, repoName, scrubId, summarizeTool } from './redact.js';
import {
  OfficeEventSchema,
  RemoteSessionIdSchema,
  RunIdSchema,
  type Actor,
  type EventKind,
  type OfficeEvent,
  type Source,
} from './schema.js';

export interface NormalizeContext {
  /** fingerprint(source, rawStdin) */
  id: string;
  /** ms since epoch, set by the emitter */
  emittedAt: number;
  source: Source;
  /** CLAUDE_CODE_REMOTE_SESSION_ID (cloud). Dropped if malformed. */
  remoteSessionId?: string | undefined;
  /** AGENT_OFFICE_RUN_ID (bridge runs). Dropped if malformed. */
  runId?: string | undefined;
}

/** Hook event name -> kind (§7 table). Anything else is not ours: null. */
export const HOOK_KIND: Readonly<Record<string, EventKind>> = {
  SessionStart: 'session.start',
  SessionEnd: 'session.end',
  UserPromptSubmit: 'prompt.submit',
  SubagentStart: 'agent.start',
  SubagentStop: 'agent.stop',
  PreToolUse: 'tool.start',
  PostToolUse: 'tool.end',
  PostToolUseFailure: 'tool.fail',
  PermissionRequest: 'permission.request',
  Notification: 'notification',
  Stop: 'turn.stop',
  StopFailure: 'turn.error',
};

type Raw = Record<string, unknown>;

function str(raw: Raw, key: string): string | undefined {
  const v = raw[key];
  return typeof v === 'string' ? v : undefined;
}

function nonEmpty(s: string | undefined): string | undefined {
  return s !== undefined && s.length > 0 ? s : undefined;
}

// Schema limits. BUG-07: overlong values are cut to these instead of dropping the event.
const MAX_AGENT_TYPE = 100;
const MAX_ID = 200;
const MAX_TOOL_NAME = 200;
/** An agent_type made only of invisible/control characters still names a subagent. */
const UNKNOWN_TYPE = 'unknown';

/**
 * Ids are cut, never given an ellipsis, so they keep their charset. An id that
 * holds a known secret shape becomes "redacted" as a whole (B-09).
 */
function cutId(s: string | undefined): string | undefined {
  const cut = nonEmpty(s?.slice(0, MAX_ID));
  return cut === undefined ? undefined : scrubId(cut);
}

function actorOf(raw: Raw): Actor {
  const rawType = nonEmpty(str(raw, 'agent_type'));
  if (!rawType) return { kind: 'main', agentType: null, agentId: null };
  // BUG-07: agent types and tool names are shown in the UI, so they are scrubbed too.
  const agentType = nonEmpty(cleanName(rawType, MAX_AGENT_TYPE)) ?? UNKNOWN_TYPE;
  return { kind: 'subagent', agentType, agentId: cutId(str(raw, 'agent_id')) ?? null };
}


function textFor(kind: EventKind, raw: Raw): string | undefined {
  switch (kind) {
    case 'prompt.submit': {
      // System prompts (hand-backs, task notifications, side-session briefs) are
      // not the PO's words: only their marker is forwarded, never the body.
      const prompt = str(raw, 'prompt');
      const kind = classifyPrompt(prompt);
      return kind === 'po' ? prompt : SYSTEM_PROMPT_MARKER[kind];
    }
    case 'agent.stop':
    case 'turn.stop':
      return str(raw, 'last_assistant_message');
    case 'notification':
      return str(raw, 'message');
    case 'turn.error': {
      const parts = [str(raw, 'error'), str(raw, 'last_assistant_message')].filter(nonEmpty);
      return parts.length > 0 ? parts.join(': ') : undefined;
    }
    case 'tool.fail': {
      // Only the bare "Exit code N" line; the rest of `error` is tool output.
      const first = str(raw, 'error')?.split('\n', 1)[0];
      return first && /^Exit code -?\d+$/.test(first) ? first : undefined;
    }
    default:
      return undefined;
  }
}

function durationOf(raw: Raw): number | undefined {
  const d = raw.duration_ms;
  return typeof d === 'number' && Number.isFinite(d) && d >= 0 ? Math.round(d) : undefined;
}

function valid<T>(schema: { safeParse(v: unknown): { success: boolean } }, v: T | undefined): T | undefined {
  return v !== undefined && schema.safeParse(v).success ? v : undefined;
}

/** Context ids are dropped (not replaced) when they hold a secret shape. */
function unchangedId(id: string | undefined): string | undefined {
  return id !== undefined && scrubId(id) === id ? id : undefined;
}

export function normalize(raw: unknown, ctx: NormalizeContext): OfficeEvent | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Raw;
  const hook = str(r, 'hook_event_name');
  const kind = hook !== undefined && Object.hasOwn(HOOK_KIND, hook) ? HOOK_KIND[hook] : undefined;
  const sessionId = cutId(str(r, 'session_id'));
  if (!kind || !sessionId) return null;

  const actor = actorOf(r);
  // SubagentStart/Stop with an empty agent_type come from Claude Code's internal
  // agents (prompt suggestions, /btw). They are not team members: ignore them.
  if ((kind === 'agent.start' || kind === 'agent.stop') && actor.kind === 'main') return null;

  const cwd = str(r, 'cwd');
  const remoteSessionId = unchangedId(valid(RemoteSessionIdSchema, ctx.remoteSessionId));
  const runId = unchangedId(valid(RunIdSchema, ctx.runId));
  const repo = repoName(cwd);
  const rawText = textFor(kind, r);

  const event: Record<string, unknown> = {
    v: 1,
    id: ctx.id,
    emittedAt: ctx.emittedAt,
    source: ctx.source,
    sessionId,
    actor,
    kind,
  };
  if (remoteSessionId) event.remoteSessionId = remoteSessionId;
  if (runId) event.runId = runId;
  if (repo) event.repo = repo;
  if (rawText !== undefined) event.text = redactText(rawText);

  const rawToolName = nonEmpty(str(r, 'tool_name'));
  const toolName = rawToolName === undefined ? undefined : nonEmpty(cleanName(rawToolName, MAX_TOOL_NAME));
  if (kind === 'tool.start' || kind === 'tool.end' || kind === 'tool.fail') {
    if (!toolName) return null;
    const tool: Record<string, unknown> = { name: toolName, summary: summarizeTool(toolName, r.tool_input, cwd) };
    const useId = cutId(str(r, 'tool_use_id'));
    const durationMs = durationOf(r);
    if (useId) tool.useId = useId;
    if (durationMs !== undefined) tool.durationMs = durationMs;
    event.tool = tool;
  }
  if (kind === 'permission.request') {
    if (!toolName) return null;
    // PermissionRequest has no tool_use_id; the event id is the request id on
    // the watch path. (The v2 decision path assigns its own; see report.)
    event.permission = { requestId: ctx.id, toolName, summary: summarizeTool(toolName, r.tool_input, cwd) };
  }

  const parsed = OfficeEventSchema.safeParse(event);
  return parsed.success ? parsed.data : null;
}
