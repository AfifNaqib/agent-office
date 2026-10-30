// Avatar state machine (FR-007, FR-008, C-04). Pure: time only comes from
// event.emittedAt (reduce) or the `now` argument (tick).
import { DESK_AGENTS, type Actor, type OfficeEvent } from '../schema.js';
import { toolActivity, type Activity } from '../toolActivity.js';

/** C-04 AC: 120 s with no events at all -> idle. */
export const IDLE_AFTER_MS = 120_000;
/** FR-008: error shows for 2 s, then idle. */
export const ERROR_MS = 2_000;
/** How long an instant action (tool.end with no start, FR-010) is shown before "working". */
export const INSTANT_MS = 1_000;
/**
 * "waiting" survives the 120 s quiet rule (a bridge run waits up to 240 s for the PO),
 * but never outlives the PermissionRequest hook timeout (300 s, §11/§12).
 */
export const WAITING_MAX_MS = 300_000;
/**
 * A2.1: an avatar with open work (an open tool, or an open agent run) is exempt
 * from the 120 s quiet rule, but only for this long, measured from `since`.
 */
export const OPEN_WORK_MAX_MS = 900_000;
export const RECENT_ENDED_MAX = 32;
export const MAIN_KEY = 'main';
export const MAIN_LABEL = 'JEBON';

export type AvatarRole = 'lead' | 'desk' | 'visitor';

export interface AvatarState {
  /** 'main' | desk agent type | 'visitor:<agentType>' */
  readonly key: string;
  readonly role: AvatarRole;
  readonly label: string;
  readonly agentType: string | null;
  readonly agentId: string | null;
  /** In the room. Visitors leave when they go idle. */
  readonly present: boolean;
  readonly activity: Activity;
  /** One-shot action: a tool.end that had no matching tool.start (FR-010). */
  readonly instant: boolean;
  /** emittedAt of the event that set `activity`. */
  readonly since: number;
  readonly tool: { readonly name: string; readonly summary: string } | null;
  /** tool_use_ids in progress. */
  readonly openTools: readonly string[];
  /** A2.1: an agent.start was seen and no agent.stop / turn.stop / idle since. */
  readonly agentOpen: boolean;
  /** Recently ended tool_use_ids, so a late tool.start does not reopen them. */
  readonly recentEnded: readonly string[];
  readonly errorUntil: number | null;
}

export interface OfficeState {
  readonly avatars: Readonly<Record<string, AvatarState>>;
  /** emittedAt of the newest event applied (0 = none). */
  readonly lastEventAt: number;
}

const DESKS: ReadonlySet<string> = new Set(DESK_AGENTS);

export function avatarKey(actor: Actor): string {
  if (actor.kind === 'main' || actor.agentType === null) return MAIN_KEY;
  return DESKS.has(actor.agentType) ? actor.agentType : `visitor:${actor.agentType}`;
}

function newAvatar(key: string, actor: Actor | null, at: number): AvatarState {
  const agentType = key === MAIN_KEY ? null : (actor?.agentType ?? key);
  return {
    key,
    role: key === MAIN_KEY ? 'lead' : DESKS.has(key) ? 'desk' : 'visitor',
    label: key === MAIN_KEY ? MAIN_LABEL : (agentType ?? key),
    agentType,
    agentId: actor?.agentId ?? null,
    present: true,
    activity: 'idle',
    instant: false,
    since: at,
    tool: null,
    openTools: [],
    agentOpen: false,
    recentEnded: [],
    errorUntil: null,
  };
}

/** JEBON plus the four desk agents, all idle. Visitors appear on demand. */
export function initialOfficeState(): OfficeState {
  const avatars: Record<string, AvatarState> = { [MAIN_KEY]: newAvatar(MAIN_KEY, null, 0) };
  for (const a of DESK_AGENTS) {
    avatars[a] = newAvatar(a, { kind: 'subagent', agentType: a, agentId: null }, 0);
  }
  return { avatars, lastEventAt: 0 };
}

function set(a: AvatarState, activity: Activity, at: number, extra: Partial<AvatarState> = {}): AvatarState {
  return { ...a, activity, since: at, instant: false, errorUntil: null, ...extra };
}

/** Back to idle. `leave` = visitors walk out (quiet timeout, session end). */
function toIdle(a: AvatarState, at: number, leave: boolean): AvatarState {
  return set(a, 'idle', at, {
    tool: null,
    openTools: [],
    agentOpen: false,
    present: leave ? a.role !== 'visitor' : a.present,
  });
}

/** A2.1: busy = an open tool or an open agent run. */
function isBusy(a: AvatarState): boolean {
  return a.openTools.length > 0 || a.agentOpen;
}

function remember(list: readonly string[], id: string | undefined): readonly string[] {
  if (!id || list.includes(id)) return list;
  const next = [...list, id];
  return next.length > RECENT_ENDED_MAX ? next.slice(next.length - RECENT_ENDED_MAX) : next;
}

function without(list: readonly string[], id: string | undefined): readonly string[] {
  return id ? list.filter((x) => x !== id) : list;
}

/**
 * Time-based transitions for one avatar. Returns `a` itself when nothing changes.
 * `quietAt` (lastEventAt + IDLE_AFTER_MS) is set once the office has been quiet
 * for 120 s; it is the time the avatar went idle, whatever `now` the tick ran at
 * (BUG-11), so the result does not depend on the timer's cadence.
 */
function tickAvatar(a: AvatarState, now: number, quietAt: number | null): AvatarState {
  const quiet = quietAt !== null;
  let next = a;
  if (next.activity === 'error' && next.errorUntil !== null && now >= next.errorUntil) {
    next = toIdle(next, next.errorUntil, false);
  }
  if (next.instant && now - next.since >= INSTANT_MS) {
    next = set(next, 'working', next.since + INSTANT_MS, { tool: null });
  }
  if (next.activity === 'waiting' && now - next.since >= WAITING_MAX_MS) {
    next = toIdle(next, next.since + WAITING_MAX_MS, quiet);
  }
  // A2.1: open work is capped at OPEN_WORK_MAX_MS from `since`, whatever the tick cadence.
  if (isBusy(next) && now - next.since >= OPEN_WORK_MAX_MS) {
    next = toIdle(next, next.since + OPEN_WORK_MAX_MS, true);
  }
  if (quietAt !== null && !isBusy(next) && next.activity !== 'waiting' && (next.activity !== 'idle' || (next.present && next.role === 'visitor'))) {
    next = toIdle(next, next.activity === 'idle' ? next.since : Math.max(quietAt, next.since), true);
  }
  return next;
}

/**
 * Advance time. Expires errors (2 s) and instant actions (1 s), ages out "waiting"
 * (300 s) and, after 120 s with no events at all, idles everyone except "waiting"
 * and avatars with open work (A2.1; those idle after OPEN_WORK_MAX_MS, 15 min);
 * idle visitors then leave. Returns the same object when nothing changes.
 */
export function tick(state: OfficeState, now: number): OfficeState {
  const quietAt = state.lastEventAt > 0 && now - state.lastEventAt >= IDLE_AFTER_MS ? state.lastEventAt + IDLE_AFTER_MS : null;
  let changed = false;
  const avatars: Record<string, AvatarState> = {};
  for (const [k, a] of Object.entries(state.avatars)) {
    const next = tickAvatar(a, now, quietAt);
    if (next !== a) changed = true;
    avatars[k] = next;
  }
  return changed ? { ...state, avatars } : state;
}

function applyToAvatar(a: AvatarState, e: OfficeEvent): AvatarState {
  const at = e.emittedAt;
  const tool = e.tool;
  switch (e.kind) {
    case 'session.start':
      return toIdle({ ...a, present: true }, at, true);
    case 'prompt.submit':
      return set(a, 'working', at, { tool: null });
    case 'agent.start':
      return set(a, 'working', at, { present: true, tool: null, openTools: [], agentOpen: true });
    case 'agent.stop':
    case 'turn.stop':
      return set(a, 'done', at, { tool: null, openTools: [], agentOpen: false });
    case 'tool.start': {
      if (!tool || (tool.useId && a.recentEnded.includes(tool.useId))) return a; // late start after its end
      return set(a, toolActivity(tool.name), at, {
        present: true,
        tool: { name: tool.name, summary: tool.summary },
        openTools: remember(a.openTools, tool.useId),
      });
    }
    case 'tool.end': {
      if (!tool) return a;
      const matched = tool.useId !== undefined && a.openTools.includes(tool.useId);
      const recentEnded = remember(a.recentEnded, tool.useId);
      if (!matched) {
        return set(a, toolActivity(tool.name), at, {
          instant: true,
          present: true,
          tool: { name: tool.name, summary: tool.summary },
          recentEnded,
        });
      }
      const openTools = without(a.openTools, tool.useId);
      if (openTools.length > 0) return { ...a, openTools, recentEnded };
      return set(a, 'working', at, { tool: null, openTools, recentEnded });
    }
    case 'tool.fail':
      return set(a, 'error', at, {
        errorUntil: at + ERROR_MS,
        tool: tool ? { name: tool.name, summary: tool.summary } : a.tool,
        openTools: without(a.openTools, tool?.useId),
        recentEnded: remember(a.recentEnded, tool?.useId),
      });
    case 'turn.error':
      return set(a, 'error', at, { errorUntil: at + ERROR_MS, tool: null, openTools: [] });
    case 'permission.request':
      return set(a, 'waiting', at, {
        tool: e.permission ? { name: e.permission.toolName, summary: e.permission.summary } : a.tool,
      });
    case 'permission.resolved':
      return a.activity === 'waiting' ? set(a, 'working', at, { tool: null }) : a;
    case 'notification':
    case 'run.status':
    case 'session.end':
      return a;
  }
}

export function reduce(state: OfficeState, e: OfficeEvent): OfficeState {
  const ticked = tick(state, e.emittedAt);
  const lastEventAt = Math.max(ticked.lastEventAt, e.emittedAt);

  if (e.kind === 'session.end') {
    const avatars: Record<string, AvatarState> = {};
    for (const [k, a] of Object.entries(ticked.avatars)) avatars[k] = toIdle(a, e.emittedAt, true);
    return { avatars, lastEventAt };
  }

  const key = avatarKey(e.actor);
  const current = ticked.avatars[key] ?? newAvatar(key, e.actor, e.emittedAt);
  const withId = e.actor.agentId && e.actor.agentId !== current.agentId ? { ...current, agentId: e.actor.agentId } : current;
  const next = applyToAvatar(withId, e);
  return { avatars: { ...ticked.avatars, [key]: next }, lastEventAt };
}
