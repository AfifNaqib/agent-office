// Session reducer for the lobby (FR-011, FR-016) and the client reorder buffer
// (FR-010, C-06). Pure: time only comes from event.emittedAt or a `now` argument.
import { classifyPrompt } from '../prompt.js';
import type { EventKind, OfficeEvent, Source } from '../schema.js';

// ---------------------------------------------------------------------------
// Sessions (lobby)
// ---------------------------------------------------------------------------

/** No events for this long -> "idle" (same quiet window as the avatar reducer). */
export const SESSION_IDLE_AFTER_MS = 120_000;

export type SessionStatus = 'live' | 'idle' | 'ended';

export interface SessionSummary {
  /** `source:sessionId`, the relay's session_key (§7). */
  readonly key: string;
  readonly source: Source;
  readonly sessionId: string;
  readonly remoteSessionId: string | null;
  /** Set when the bridge started the run (AGENT_OFFICE_RUN_ID). */
  readonly runId: string | null;
  readonly repo: string | null;
  readonly startedAt: number;
  readonly lastEventAt: number;
  readonly endedAt: number | null;
  readonly eventCount: number;
  /**
   * Hidden "side session" (S2): its first prompt is a "Background (from the
   * session that started this one)" brief. Derived from the event stream, not a
   * wire field. It never sends SessionEnd; the quiet rule idles it.
   */
  readonly side: boolean;
  /** A prompt.submit was seen, so `side` is decided and never changes again. */
  readonly sawPrompt: boolean;
}

export interface SessionsState {
  readonly sessions: Readonly<Record<string, SessionSummary>>;
}

export interface LobbyEntry extends SessionSummary {
  readonly status: SessionStatus;
  /** Local, bridge-owned (runId) and not ended. FR-029's other condition (bridge online) is the UI's. */
  readonly controllable: boolean;
  /** FR-016 deep link for cloud sessions, else null. */
  readonly openUrl: string | null;
}

export function sessionKey(e: Pick<OfficeEvent, 'source' | 'sessionId'>): string {
  return `${e.source}:${e.sessionId}`;
}

/** FR-016: https://claude.ai/code/<id with cse_ -> session_>. Input is schema-validated upstream. */
export function claudeCodeUrl(remoteSessionId: string): string {
  return `https://claude.ai/code/${remoteSessionId.replace(/^cse_/, 'session_')}`;
}

export function initialSessionsState(): SessionsState {
  return { sessions: {} };
}

export function reduceSessions(state: SessionsState, e: OfficeEvent): SessionsState {
  const key = sessionKey(e);
  const at = e.emittedAt;
  const cur = state.sessions[key];
  const base: SessionSummary = cur ?? {
    key,
    source: e.source,
    sessionId: e.sessionId,
    remoteSessionId: null,
    runId: null,
    repo: null,
    startedAt: at,
    lastEventAt: at,
    endedAt: null,
    eventCount: 0,
    side: false,
    sawPrompt: false,
  };
  const firstPrompt = e.kind === 'prompt.submit' && !base.sawPrompt;
  let endedAt = base.endedAt;
  if (e.kind === 'session.end') endedAt = Math.max(endedAt ?? at, at);
  else if (endedAt !== null && at > endedAt) endedAt = null; // resumed after its end
  const next: SessionSummary = {
    ...base,
    remoteSessionId: base.remoteSessionId ?? e.remoteSessionId ?? null,
    runId: base.runId ?? e.runId ?? null,
    repo: base.repo ?? e.repo ?? null,
    startedAt: Math.min(base.startedAt, at),
    lastEventAt: Math.max(base.lastEventAt, at),
    endedAt,
    eventCount: base.eventCount + 1,
    side: firstPrompt ? classifyPrompt(e.text) === 'side-session' : base.side,
    sawPrompt: base.sawPrompt || firstPrompt,
  };
  return { sessions: { ...state.sessions, [key]: next } };
}

export function sessionStatus(s: SessionSummary, now: number): SessionStatus {
  if (s.endedAt !== null) return 'ended';
  return now - s.lastEventAt >= SESSION_IDLE_AFTER_MS ? 'idle' : 'live';
}

export interface LobbyOptions {
  /** Include hidden side sessions (default false). */
  readonly includeSide?: boolean;
}

/**
 * FR-011: all sessions, newest activity first (ties by key, so the order is stable).
 * Side sessions are left out unless `includeSide` is set; their events stay in state.
 */
export function lobby(state: SessionsState, now: number, options: LobbyOptions = {}): LobbyEntry[] {
  return Object.values(state.sessions)
    .filter((s) => options.includeSide === true || !s.side)
    .map((s): LobbyEntry => {
      const status = sessionStatus(s, now);
      return {
        ...s,
        status,
        // BUG-09: only bridge runs on the PC can be stopped/messaged from here.
        controllable: s.source === 'local' && s.runId !== null && status !== 'ended',
        openUrl: s.source === 'cloud' && s.remoteSessionId ? claudeCodeUrl(s.remoteSessionId) : null,
      };
    })
    .sort((a, b) => b.lastEventAt - a.lastEventAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Reorder buffer (FR-010): events are applied in (emittedAt, id) order. Each
// event is held for REORDER_WINDOW_MS after it ARRIVED (receiver clock, so
// emitter clock skew does not matter). Releasing an event also releases every
// pending event OF THE SAME SESSION that sorts before it. Anything delayed by
// less than the window therefore comes out in order. Duplicate ids are dropped.
//
// BUG-04: ordering state is per session (sessionKey), so one session with a
// skewed clock cannot disable reordering for the others, and emittedAt is
// clamped on push (clampEmittedAt), so one far-future timestamp cannot poison
// the per-session marker or the reducers' "newest event" time.
//
// Clocks: every `now` in this file, in tick(state, now) and in lobby(state, now)
// is the RECEIVER's wall clock (Date.now() in the web UI). emittedAt is the
// emitter's clock, clamped here to within the bounds below of the receive time.
// ---------------------------------------------------------------------------

export const REORDER_WINDOW_MS = 500;
/** Ids remembered for dedupe. The bridge/relay dedupe for 7 days; this only covers live redelivery. */
export const SEEN_MAX = 4096;
/**
 * emittedAt may be at most this far AHEAD of the receive time (BUG-04). Kept
 * well under the 120 s quiet rule, so a clamped event delays "idle" by ≤ 60 s.
 */
export const MAX_FUTURE_SKEW_MS = 60_000;
/**
 * emittedAt may be at most this far BEHIND the server's receivedAt: the 7-day
 * retention, so honestly delayed deliveries keep their real order. Applied only
 * when the event carries receivedAt; a client arrival time says nothing about
 * history, which is loaded long after it was emitted.
 */
export const MAX_PAST_SKEW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Bound emittedAt to [receivedAt − MAX_PAST_SKEW_MS, ref + MAX_FUTURE_SKEW_MS],
 * where ref = event.receivedAt (bridge/relay clock) when set, else `now` (the
 * receiver's clock at arrival). Returns the same object when nothing changes.
 */
export function clampEmittedAt(e: OfficeEvent, now: number): OfficeEvent {
  const ref = e.receivedAt ?? now;
  const hi = ref + MAX_FUTURE_SKEW_MS;
  const lo = e.receivedAt === undefined ? 0 : Math.max(0, e.receivedAt - MAX_PAST_SKEW_MS);
  const at = Math.min(Math.max(e.emittedAt, lo), hi);
  return at === e.emittedAt ? e : { ...e, emittedAt: at };
}

interface Pending {
  readonly event: OfficeEvent;
  readonly key: string;
  readonly arrivedAt: number;
}

export interface Marker {
  readonly emittedAt: number;
  readonly id: string;
  readonly kind: EventKind;
}

export interface ReorderState {
  /** Sorted by (emittedAt, id). */
  readonly pending: readonly Pending[];
  readonly seen: readonly string[];
  /** Newest released event per session key. */
  readonly last: Readonly<Record<string, Marker>>;
}

export interface Drained {
  readonly state: ReorderState;
  /** Events to apply now, in (emittedAt, id) order. */
  readonly ready: readonly OfficeEvent[];
  /** How many of `ready` sort before something already released in their session (arrived too late to reorder). */
  readonly late: number;
}

/**
 * B-06: on an emittedAt tie a permission.request sorts before everything else and a
 * permission.resolved after everything else, so a decision never lands before its
 * request. A fixed rank (not a pairwise rule) keeps the order total and transitive.
 */
function tieRank(kind: EventKind | undefined): number {
  return kind === 'permission.request' ? 0 : kind === 'permission.resolved' ? 2 : 1;
}

export function compareEvents(
  a: { emittedAt: number; id: string; kind?: EventKind },
  b: { emittedAt: number; id: string; kind?: EventKind },
): number {
  return a.emittedAt - b.emittedAt || tieRank(a.kind) - tieRank(b.kind) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function initialReorderState(): ReorderState {
  return { pending: [], seen: [], last: {} };
}

/** Accept one delivered event at receiver time `now`. Duplicates are ignored; emittedAt is clamped. */
export function bufferPush(state: ReorderState, delivered: OfficeEvent, now: number): ReorderState {
  if (state.seen.includes(delivered.id)) return state;
  const event = clampEmittedAt(delivered, now);
  const seen = [...state.seen, event.id];
  let i = state.pending.length;
  while (i > 0 && compareEvents((state.pending[i - 1] as Pending).event, event) > 0) i -= 1;
  const entry: Pending = { event, key: sessionKey(event), arrivedAt: now };
  const pending = [...state.pending.slice(0, i), entry, ...state.pending.slice(i)];
  return { ...state, pending, seen: seen.length > SEEN_MAX ? seen.slice(seen.length - SEEN_MAX) : seen };
}

function isLate(state: ReorderState, p: Pending): boolean {
  const last = state.last[p.key];
  return last !== undefined && compareEvents(p.event, last) < 0;
}

/** Release the pending entries for which `take(index)` is true. */
function release(state: ReorderState, take: (p: Pending, i: number) => boolean): Drained {
  const ready: OfficeEvent[] = [];
  const keep: Pending[] = [];
  const last: Record<string, Marker> = { ...state.last };
  let late = 0;
  state.pending.forEach((p, i) => {
    if (!take(p, i)) {
      keep.push(p);
      return;
    }
    ready.push(p.event);
    if (isLate(state, p)) late += 1;
    const prev = last[p.key];
    if (!prev || compareEvents(p.event, prev) > 0) last[p.key] = { emittedAt: p.event.emittedAt, id: p.event.id, kind: p.event.kind };
  });
  if (ready.length === 0) return { state, ready: [], late: 0 };
  return { state: { ...state, pending: keep, last }, ready, late };
}

/** Release every event that is due at `now`, plus everything of its session that sorts before it. */
export function bufferDrain(state: ReorderState, now: number): Drained {
  const cut = new Map<string, number>();
  state.pending.forEach((p, i) => {
    if (isLate(state, p) || now - p.arrivedAt >= REORDER_WINDOW_MS) cut.set(p.key, i);
  });
  if (cut.size === 0) return { state, ready: [], late: 0 };
  return release(state, (p, i) => i <= (cut.get(p.key) ?? -1));
}

/** Release everything now (e.g. after loading history, or on teardown). */
export function bufferFlush(state: ReorderState): Drained {
  return release(state, () => true);
}

/** When the next drain should run (receiver clock), or null if nothing is pending. */
export function nextDrainAt(state: ReorderState): number | null {
  let next: number | null = null;
  for (const p of state.pending) {
    const due = isLate(state, p) ? p.arrivedAt : p.arrivedAt + REORDER_WINDOW_MS;
    if (next === null || due < next) next = due;
  }
  return next;
}
