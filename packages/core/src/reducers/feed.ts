// Feed reducer (FR-009, C-05). Pure. Produces plain-text items only: no HTML is
// ever built here. The UI renders every string as a text node (§11 XSS), so
// escaping is the renderer's job and must not be done twice.
import { truncate } from '../redact.js';
import type { OfficeEvent, PermissionInfo } from '../schema.js';
import { classifyPrompt } from '../prompt.js';
import { HANDBACK_TOOL, toolDisplay } from '../toolActivity.js';
import { MAIN_LABEL, avatarKey } from './avatar.js';

/** FR-009: more than 3 consecutive tool lines from one actor collapse into a group. */
export const GROUP_AFTER = 3;
/** FR-009: "done: <summary≤200>". */
export const DONE_MAX = 200;
/**
 * The line already starts with "done:", so a final message that itself starts with
 * "done" + punctuation ("done.", "Done: tests pass") would read "done: done.".
 * Only that bare lead-in is dropped; "done with the build" is left alone.
 */
export function stripDonePrefix(text: string): string {
  return text.replace(/^done(?:[.:!]+\s*|$)/i, '');
}

/** Oldest items are dropped past this, so a long session cannot grow memory without bound. */
export const MAX_FEED_ITEMS = 500;
/** A1.1: at most this many pending actionable permission cards are pinned under the cap. */
export const MAX_PINNED = 20;
/** A1.1: a pending card is no longer tracked after this long (same as WAITING_MAX_MS). */
export const PERMISSION_TTL_MS = 300_000;
/** Bound on the bookkeeping lists (open tool ids, pending delegations). */
export const MAX_TRACKED = 64;
/** B-06: at most this many decisions that arrived before their request are remembered. */
export const MAX_ORPHAN_DECISIONS = 50;

export type LineKind = 'session' | 'prompt' | 'starting' | 'done' | 'tool' | 'error' | 'notification' | 'run';

interface ItemBase {
  /** Stable key for the UI list (derived from event ids, never random). */
  readonly id: string;
  /** emittedAt of the event that created the item. */
  readonly at: number;
  /** Same key as the avatar reducer: 'main' | desk agent | 'visitor:<type>'. */
  readonly actorKey: string;
  readonly actorLabel: string;
}

export interface FeedLine extends ItemBase {
  readonly type: 'line';
  readonly kind: LineKind;
  /** Plain text. Already redacted upstream; never HTML. */
  readonly text: string;
  /** Set on tool lines, so grouping can count them. */
  readonly toolName?: string;
}

export interface FeedGroup extends ItemBase {
  readonly type: 'group';
  /** Tool calls folded into this line, keyed by category, e.g. { edits: 4, commands: 1 }. */
  readonly counts: Readonly<Record<string, number>>;
  readonly total: number;
  /** "coder: 4 edits, 1 command" */
  readonly text: string;
}

export type PermissionStatus = 'pending' | 'allow' | 'deny' | 'expired';

/** What closed a card (A1.1). 'decision' is a permission.resolved event. */
export type PermissionSettledBy = 'decision' | 'activity' | 'turn' | 'session' | 'run' | 'timeout';

export interface FeedPermission extends ItemBase {
  readonly type: 'permission';
  readonly requestId: string;
  readonly toolName: string;
  readonly summary: string;
  readonly status: PermissionStatus;
  /** Only bridge runs can be decided from the visualizer (FR-016, FR-029). */
  readonly runId: string | null;
  /**
   * A1.1: true only for bridge runs (local source with a runId). Anything else
   * is informational: it never gets buttons, and activity can close it.
   */
  readonly actionable: boolean;
  /** Set once status leaves 'pending'. */
  readonly settledBy?: PermissionSettledBy;
}

export type FeedItem = FeedLine | FeedGroup | FeedPermission;

/** B-06: a permission.resolved whose request has not been seen (yet). Dropped when matched or after the card TTL. */
export interface OrphanDecision {
  readonly requestId: string;
  readonly decision: NonNullable<PermissionInfo['decision']>;
  /** emittedAt of the permission.resolved event. */
  readonly at: number;
}

export interface FeedState {
  readonly items: readonly FeedItem[];
  /** tool_use_ids whose tool.start produced a line (to spot unmatched tool.end). */
  readonly openToolIds: readonly string[];
  /** Agent tool summaries ("architect: Review the plan") waiting for their agent.start. */
  readonly pendingDelegations: readonly string[];
  /** B-06: decisions waiting for their request (bounded by MAX_ORPHAN_DECISIONS). */
  readonly orphanDecisions: readonly OrphanDecision[];
}

export function initialFeedState(): FeedState {
  return { items: [], openToolIds: [], pendingDelegations: [], orphanDecisions: [] };
}

// ---- text helpers ----

// C0/C1 controls (except tab and newline) and Unicode bidi overrides, which could
// make a line render differently from what it says.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** Plain text for display: unsafe control characters removed. Not HTML-escaped (see header). */
export function plainText(s: string): string {
  return s.replace(UNSAFE_CHARS, '');
}

function labelOf(key: string, e: OfficeEvent): string {
  return key === 'main' ? MAIN_LABEL : plainText(e.actor.agentType ?? key);
}

const CATEGORY: Readonly<Record<string, string>> = {
  Edit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'command',
  PowerShell: 'command',
  Read: 'read',
  Grep: 'search',
  Glob: 'search',
  WebFetch: 'fetch',
  WebSearch: 'web search',
  Agent: 'delegation',
  Task: 'delegation',
  [HANDBACK_TOOL]: 'report',
};
/** Fixed display order, so the same counts always give the same text. */
const CATEGORY_ORDER = ['edit', 'command', 'read', 'search', 'fetch', 'web search', 'delegation', 'report', 'tool call'];
const PLURAL: Readonly<Record<string, string>> = { search: 'searches', fetch: 'fetches', 'web search': 'web searches' };

export function toolCategory(toolName: string): string {
  return Object.hasOwn(CATEGORY, toolName) ? (CATEGORY[toolName] ?? 'tool call') : 'tool call';
}

export function groupText(label: string, counts: Readonly<Record<string, number>>): string {
  const parts = CATEGORY_ORDER.filter((c) => (counts[c] ?? 0) > 0).map((c) => {
    const n = counts[c] ?? 0;
    return `${n} ${n === 1 ? c : (PLURAL[c] ?? `${c}s`)}`;
  });
  return `${label}: ${parts.join(', ')}`;
}

function toolLineText(name: string, summary: string): string {
  return toolDisplay(plainText(name), plainText(summary));
}

function bounded(list: readonly string[], add: string): readonly string[] {
  const next = [...list, add];
  return next.length > MAX_TRACKED ? next.slice(next.length - MAX_TRACKED) : next;
}

function removeFirst(list: readonly string[], i: number): readonly string[] {
  return i < 0 ? list : [...list.slice(0, i), ...list.slice(i + 1)];
}

// ---- item builders ----

function who(e: OfficeEvent): { actorKey: string; actorLabel: string } {
  const actorKey = avatarKey(e.actor);
  return { actorKey, actorLabel: labelOf(actorKey, e) };
}

function line(e: OfficeEvent, kind: LineKind, text: string, toolName?: string): FeedLine {
  const item: FeedLine = { type: 'line', id: e.id, at: e.emittedAt, ...who(e), kind, text };
  return toolName === undefined ? item : { ...item, toolName };
}

/** Append a tool line; the (GROUP_AFTER+1)th consecutive one from the same actor folds the run into a group. */
function addToolLine(items: readonly FeedItem[], item: FeedLine & { toolName: string }): readonly FeedItem[] {
  const last = items.at(-1);
  const cat = toolCategory(item.toolName);
  if (last?.type === 'group' && last.actorKey === item.actorKey) {
    const counts = { ...last.counts, [cat]: (last.counts[cat] ?? 0) + 1 };
    const group: FeedGroup = { ...last, counts, total: last.total + 1, text: groupText(last.actorLabel, counts) };
    return [...items.slice(0, -1), group];
  }
  let start = items.length;
  while (start > 0) {
    const prev = items[start - 1];
    if (prev?.type !== 'line' || prev.kind !== 'tool' || prev.actorKey !== item.actorKey) break;
    start -= 1;
  }
  const run = items.slice(start) as readonly FeedLine[];
  if (run.length < GROUP_AFTER) return [...items, item];
  const counts: Record<string, number> = {};
  for (const l of [...run, item]) {
    const c = toolCategory(l.toolName ?? '');
    counts[c] = (counts[c] ?? 0) + 1;
  }
  const first = run[0] ?? item;
  const group: FeedGroup = {
    type: 'group',
    id: `group:${first.id}`,
    at: first.at,
    actorKey: item.actorKey,
    actorLabel: item.actorLabel,
    counts,
    total: run.length + 1,
    text: groupText(item.actorLabel, counts),
  };
  return [...items.slice(0, start), group];
}

// ---- permission cards (A1.1) ----

const isPendingCard = (it: FeedItem): it is FeedPermission => it.type === 'permission' && it.status === 'pending';

/** Close `card` as expired. */
function expire(card: FeedPermission, settledBy: PermissionSettledBy): FeedPermission {
  return { ...card, status: 'expired', settledBy };
}

/** Rewrite the pending cards for which `settle` returns a reason. Same state object when none match. */
function settleCards(
  state: FeedState,
  settle: (card: FeedPermission) => PermissionSettledBy | undefined,
): FeedState {
  const items = state.items.map((it) => {
    if (!isPendingCard(it)) return it;
    const by = settle(it);
    return by === undefined ? it : expire(it, by);
  });
  return items.some((it, i) => it !== state.items[i]) ? { ...state, items } : state;
}

/**
 * Advance time (A1.1): a pending card older than PERMISSION_TTL_MS expires with
 * settledBy 'timeout'. Pure and idempotent; returns the same object when nothing changes.
 */
export function tickFeed(state: FeedState, now: number): FeedState {
  const settled = settleCards(state, (c) => (now - c.at >= PERMISSION_TTL_MS ? 'timeout' : undefined));
  // B-06: a remembered decision whose request never came is dropped after the same TTL.
  const orphanDecisions = settled.orphanDecisions.filter((o) => now - o.at < PERMISSION_TTL_MS);
  return orphanDecisions.length === settled.orphanDecisions.length ? settled : { ...settled, orphanDecisions };
}

const RUN_ENDED = new Set(['exited', 'stopped', 'failed']);

/**
 * A1.1 settle rules for the event's own effect on pending cards. Inference only
 * ever produces 'expired', never allow/deny. Actionable cards are decided by the
 * bridge: only the session ending or their run ending closes them here. The
 * trigger must not be older than the card (emittedAt >= card.at).
 */
function settleOnEvent(state: FeedState, e: OfficeEvent): FeedState {
  switch (e.kind) {
    case 'session.end':
      return settleCards(state, () => 'session');
    case 'run.status':
      if (!e.run || !RUN_ENDED.has(e.run.status) || e.runId === undefined) return state;
      return settleCards(state, (c) => (c.actionable && c.runId === e.runId && e.emittedAt >= c.at ? 'run' : undefined));
    case 'tool.end':
    case 'tool.fail': {
      const name = e.tool ? plainText(e.tool.name) : undefined;
      const actor = avatarKey(e.actor);
      return settleCards(state, (c) =>
        !c.actionable && e.emittedAt >= c.at && c.actorKey === actor && c.toolName === name ? 'activity' : undefined,
      );
    }
    case 'agent.stop':
    case 'turn.stop':
    case 'turn.error': {
      // A2.2: a stop settles only its own actor's cards. A main turn.stop never settles a subagent's card.
      const actor = avatarKey(e.actor);
      return settleCards(state, (c) => (!c.actionable && e.emittedAt >= c.at && c.actorKey === actor ? 'turn' : undefined));
    }
    case 'prompt.submit':
      // A2.2: only something the PO typed settles cards (any actor). Hand-backs, task
      // notifications, side-session briefs and prompts with no text never do.
      if (!e.text || classifyPrompt(e.text) !== 'po') return state;
      return settleCards(state, (c) => (!c.actionable && e.emittedAt >= c.at ? 'turn' : undefined));
    default:
      return state;
  }
}

/**
 * permission.resolved precedence (A1.1): allow/deny beat pending and expired (a
 * real decision beats an inferred one); expired only closes a pending card;
 * anything else on a settled card is a no-op.
 */
function decide(card: FeedPermission, decision: NonNullable<PermissionInfo['decision']>): FeedPermission {
  const overridable = decision === 'expired' ? card.status === 'pending' : card.status === 'pending' || card.status === 'expired';
  return overridable ? { ...card, status: decision, settledBy: 'decision' } : card;
}

function resolvePermission(items: readonly FeedItem[], p: PermissionInfo): readonly FeedItem[] {
  const i = items.findIndex((it) => it.type === 'permission' && it.requestId === p.requestId);
  const card = items[i];
  if (card?.type !== 'permission' || !p.decision) return items;
  const next = decide(card, p.decision);
  return next === card ? items : [...items.slice(0, i), next, ...items.slice(i + 1)];
}

/** B-06: remember a decision whose request is unknown. A real decision beats an earlier 'expired' for the same id. */
function rememberOrphan(list: readonly OrphanDecision[], o: OrphanDecision): readonly OrphanDecision[] {
  const i = list.findIndex((x) => x.requestId === o.requestId);
  const prev = list[i];
  if (prev !== undefined) {
    if (prev.decision !== 'expired' || o.decision === 'expired') return list;
    return [...list.slice(0, i), o, ...list.slice(i + 1)];
  }
  const next = [...list, o];
  return next.length > MAX_ORPHAN_DECISIONS ? next.slice(next.length - MAX_ORPHAN_DECISIONS) : next;
}

/**
 * Keep at most MAX_FEED_ITEMS, dropping the oldest non-pinned items first.
 * Pinned = pending actionable cards, newest MAX_PINNED only (NB-02); older ones
 * count as normal items. Informational cards are never pinned. Pinned cards are
 * at most MAX_PINNED, far below the cap, so the result never exceeds it.
 */
function cap(items: readonly FeedItem[]): readonly FeedItem[] {
  if (items.length <= MAX_FEED_ITEMS) return items;
  const pinned = new Set<number>();
  for (let i = items.length - 1; i >= 0 && pinned.size < MAX_PINNED; i -= 1) {
    const it = items[i];
    if (it && isPendingCard(it) && it.actionable) pinned.add(i);
  }
  let excess = items.length - MAX_FEED_ITEMS;
  return items.filter((_it, i) => {
    if (excess > 0 && !pinned.has(i)) {
      excess -= 1;
      return false;
    }
    return true;
  });
}

/** The Agent tool's default subagent when subagent_type is omitted. */
export const DEFAULT_SUBAGENT = 'general-purpose';
/** "type: description" or a bare type, as summarizeTool writes them for typed delegations. */
const TYPED_DELEGATION = /^[\w:.-]+(?:: |$)/;

/**
 * Index of the pending delegation an agent.start belongs to: the oldest
 * "type: …" / "type" entry, else (BUG-14) for the default subagent the oldest
 * untyped entry, i.e. an Agent call without subagent_type. -1 if none.
 */
function delegationFor(pending: readonly string[], type: string): number {
  const typed = pending.findIndex((d) => d === type || d.startsWith(`${type}: `));
  if (typed >= 0 || type !== DEFAULT_SUBAGENT) return typed;
  return pending.findIndex((d) => !TYPED_DELEGATION.test(d));
}

// ---- reducer ----

/**
 * Apply one event (of one session) to the feed. Events should arrive in (emittedAt, id) order (C-06 buffer).
 * Time first (cards older than the TTL expire), then what the event settles, then the event itself.
 */
export function reduceFeed(state: FeedState, e: OfficeEvent): FeedState {
  return applyEvent(settleOnEvent(tickFeed(state, e.emittedAt), e), e);
}

function applyEvent(state: FeedState, e: OfficeEvent): FeedState {
  const push = (item: FeedItem, extra: Partial<FeedState> = {}): FeedState => ({
    ...state,
    ...extra,
    items: cap([...state.items, item]),
  });
  const tool = e.tool;

  switch (e.kind) {
    case 'session.start':
      return push(line(e, 'session', 'session started'));
    case 'session.end':
      return push(line(e, 'session', 'session ended'), { openToolIds: [], pendingDelegations: [] });
    case 'prompt.submit':
      // Hand-backs, task notifications and side-session briefs are Claude Code's own
      // messages, never "PO said" lines (S2).
      return e.text && classifyPrompt(e.text) === 'po'
        ? push({ ...line(e, 'prompt', plainText(e.text)), actorKey: 'po', actorLabel: 'PO' })
        : state;
    case 'agent.start': {
      const type = e.actor.agentType ?? '';
      const i = delegationFor(state.pendingDelegations, type);
      const found = state.pendingDelegations[i];
      const desc =
        found === undefined || found === type ? '' : found.startsWith(`${type}: `) ? found.slice(type.length + 2) : found;
      return push(line(e, 'starting', desc ? `starting: ${plainText(desc)}` : 'starting'), {
        pendingDelegations: removeFirst(state.pendingDelegations, i),
      });
    }
    case 'agent.stop':
    case 'turn.stop': {
      const summary = e.text ? truncate(stripDonePrefix(plainText(e.text)), DONE_MAX) : '';
      return push(line(e, 'done', summary ? `done: ${summary}` : 'done'));
    }
    case 'tool.start': {
      if (!tool) return state;
      const openToolIds = tool.useId ? bounded(state.openToolIds, tool.useId) : state.openToolIds;
      if (tool.name === 'Agent' || tool.name === 'Task') {
        // Shown as the subagent's "starting: <description>" line instead.
        return { ...state, openToolIds, pendingDelegations: bounded(state.pendingDelegations, tool.summary) };
      }
      const item = line(e, 'tool', toolLineText(tool.name, tool.summary), tool.name) as FeedLine & { toolName: string };
      return { ...state, openToolIds, items: cap(addToolLine(state.items, item)) };
    }
    case 'tool.end': {
      if (!tool) return state;
      const i = tool.useId ? state.openToolIds.indexOf(tool.useId) : -1;
      if (tool.name === 'Agent' || tool.name === 'Task') {
        // BUG-14: a delegation that ended without a matching agent.start leaves nothing behind.
        const d = state.pendingDelegations.indexOf(tool.summary);
        return { ...state, openToolIds: removeFirst(state.openToolIds, i), pendingDelegations: removeFirst(state.pendingDelegations, d) };
      }
      if (i >= 0) return { ...state, openToolIds: removeFirst(state.openToolIds, i) };
      // FR-010: a tool.end with no start renders as an instant action (one tool line).
      const item = line(e, 'tool', toolLineText(tool.name, tool.summary), tool.name) as FeedLine & { toolName: string };
      return { ...state, items: cap(addToolLine(state.items, item)) };
    }
    case 'tool.fail': {
      const i = tool?.useId ? state.openToolIds.indexOf(tool.useId) : -1;
      const what = tool ? toolLineText(tool.name, tool.summary) : 'tool';
      const detail = e.text ? ` (${plainText(e.text)})` : '';
      return push(line(e, 'error', `${what} failed${detail}`), { openToolIds: removeFirst(state.openToolIds, i) });
    }
    case 'turn.error':
      return push(line(e, 'error', e.text ? `error: ${plainText(e.text)}` : 'error'));
    case 'notification':
      return e.text ? push(line(e, 'notification', plainText(e.text))) : state;
    case 'permission.request': {
      const p = e.permission;
      if (!p || state.items.some((it) => it.type === 'permission' && it.requestId === p.requestId)) return state;
      let card: FeedPermission = {
        type: 'permission',
        id: `perm:${p.requestId}`,
        at: e.emittedAt,
        ...who(e),
        requestId: p.requestId,
        toolName: plainText(p.toolName),
        summary: plainText(p.summary),
        status: 'pending',
        runId: e.runId ?? null,
        actionable: e.source === 'local' && e.runId !== undefined,
      };
      // B-06: the decision arrived first; settle the card right away.
      const orphan = state.orphanDecisions.find((o) => o.requestId === p.requestId);
      if (orphan) card = decide(card, orphan.decision);
      return push(card, orphan ? { orphanDecisions: state.orphanDecisions.filter((o) => o !== orphan) } : {});
    }
    case 'permission.resolved': {
      const p = e.permission;
      if (!p?.decision) return state;
      if (state.items.some((it) => it.type === 'permission' && it.requestId === p.requestId)) {
        return { ...state, items: resolvePermission(state.items, p) };
      }
      return { ...state, orphanDecisions: rememberOrphan(state.orphanDecisions, { requestId: p.requestId, decision: p.decision, at: e.emittedAt }) };
    }
    case 'run.status': {
      if (!e.run) return state;
      const code = e.run.exitCode === undefined ? '' : ` (exit ${e.run.exitCode})`;
      return push(line(e, 'run', `run ${e.run.status}${code}`));
    }
  }
}
