// Plan Amendment A1.1 (BUG-06, NB-02): permission cards in the feed. One
// table-driven group per core acceptance criterion (AC 1 to 10), plus the
// observed Desktop/CLI permission sessions.
import { describe, expect, it } from 'vitest';
import {
  MAX_FEED_ITEMS,
  MAX_ORPHAN_DECISIONS,
  MAX_PINNED,
  PERMISSION_TTL_MS,
  initialFeedState,
  reduceFeed,
  tickFeed,
  type FeedItem,
  type FeedPermission,
  type FeedState,
} from '../src/reducers/feed.js';
import { WAITING_MAX_MS } from '../src/reducers/avatar.js';
import { bufferDrain, bufferFlush, bufferPush, compareEvents, initialReorderState, REORDER_WINDOW_MS } from '../src/reducers/session.js';
import type { Actor, EventKind, OfficeEvent, Source } from '../src/schema.js';
import { ARCH, CODER, MAIN, ev, hexId } from './helpers/events.js';
import { observedTimeline } from './helpers/fixtures.js';

const T = 40_000_000;
const run = (...events: OfficeEvent[]): FeedState => events.reduce(reduceFeed, initialFeedState());
const cards = (s: FeedState): FeedPermission[] => s.items.filter((i): i is FeedPermission => i.type === 'permission');
const card = (s: FeedState, requestId = 'r1'): FeedPermission => {
  const c = cards(s).find((x) => x.requestId === requestId);
  if (!c) throw new Error(`no card ${requestId}`);
  return c;
};

interface ReqOpts {
  requestId?: string;
  at?: number;
  source?: Source;
  runId?: string;
  actor?: Actor;
  toolName?: string;
}
/** A permission.request. Default: informational (local, no runId), main actor, tool Bash, at T. */
function request(o: ReqOpts = {}): OfficeEvent {
  const e = ev('permission.request', {
    emittedAt: o.at ?? T,
    source: o.source ?? 'local',
    actor: o.actor ?? MAIN,
    permission: { requestId: o.requestId ?? 'r1', toolName: o.toolName ?? 'Bash', summary: 'node -e' },
  });
  return o.runId === undefined ? e : { ...e, runId: o.runId };
}
const actionableReq = (o: ReqOpts = {}): OfficeEvent => request({ runId: 'run_1', ...o });

function resolved(decision: 'allow' | 'deny' | 'expired', at: number, requestId = 'r1'): OfficeEvent {
  return ev('permission.resolved', { emittedAt: at, permission: { requestId, toolName: 'Bash', summary: 'node -e', decision } });
}

/** A non-permission event at time `at`. */
function trigger(kind: EventKind, at: number, over: Partial<OfficeEvent> = {}): OfficeEvent {
  return ev(kind, { emittedAt: at, ...over });
}
const toolOf = (kind: 'tool.start' | 'tool.end' | 'tool.fail', at: number, name = 'Bash', actor: Actor = MAIN): OfficeEvent =>
  ev(kind, { emittedAt: at, actor, tool: { name, summary: 'x', useId: `u${at}${name}` } });

describe('AC1: actionable = local source with a runId', () => {
  it.each<[string, Source, string | undefined, boolean]>([
    ['local + runId', 'local', 'run_1', true],
    ['cloud + runId', 'cloud', 'run_1', false],
    ['local without runId', 'local', undefined, false],
    ['cloud without runId', 'cloud', undefined, false],
  ])('%s', (_n, source, runId, actionable) => {
    const c = card(run(request({ source, ...(runId ? { runId } : {}) })));
    expect(c.actionable).toBe(actionable);
    expect(c.status).toBe('pending');
    expect(c.runId).toBe(runId ?? null);
    expect(c.settledBy).toBeUndefined();
  });
});

describe('AC2: an informational card is closed by matching activity only', () => {
  it.each<[string, OfficeEvent, 'pending' | 'expired']>([
    ['tool.end, same actor and tool name', toolOf('tool.end', T + 10), 'expired'],
    ['tool.fail, same actor and tool name', toolOf('tool.fail', T + 10), 'expired'],
    ['tool.end, different tool name', toolOf('tool.end', T + 10, 'Read'), 'pending'],
    ['tool.fail, different tool name', toolOf('tool.fail', T + 10, 'Read'), 'pending'],
    ['tool.end, different actor', toolOf('tool.end', T + 10, 'Bash', CODER), 'pending'],
    ['tool.fail, different actor', toolOf('tool.fail', T + 10, 'Bash', ARCH), 'pending'],
    ['tool.start, same actor and name', toolOf('tool.start', T + 10), 'pending'],
    ['notification', trigger('notification', T + 10, { text: 'Claude needs your permission' }), 'pending'],
    ['permission.request (another card)', request({ requestId: 'r2', at: T + 10 }), 'pending'],
    ['run.status exited', trigger('run.status', T + 10, { run: { status: 'exited' } }), 'pending'],
    ['session.start', trigger('session.start', T + 10), 'pending'],
    ['agent.start of another actor', trigger('agent.start', T + 10, { actor: CODER }), 'pending'],
  ])('%s -> %s', (_n, e, status) => {
    const c = card(run(request(), e));
    expect(c.status).toBe(status);
    expect(c.settledBy).toBe(status === 'expired' ? 'activity' : undefined);
  });

  it('the actor key of a visitor matches too', () => {
    const visitor: Actor = { kind: 'subagent', agentType: 'Explore', agentId: 'x' };
    const s = run(request({ actor: visitor }), toolOf('tool.end', T + 5, 'Bash', visitor));
    expect(card(s)).toMatchObject({ status: 'expired', settledBy: 'activity', actorKey: 'visitor:Explore' });
  });
});

describe('A2.2 AC3: what settles informational cards (replaces A1.1 AC3)', () => {
  const po = (at: number, over: Partial<OfficeEvent> = {}) => trigger('prompt.submit', at, { text: 'go on', ...over });

  it('1. a main card is settled by a main turn.stop', () => {
    expect(card(run(request(), trigger('turn.stop', T + 10)))).toMatchObject({ status: 'expired', settledBy: 'turn', actionable: false });
  });

  it('2. a coder card is NOT settled by a main turn.stop; coder agent.stop settles it', () => {
    const s = run(request({ actor: CODER }), trigger('turn.stop', T + 10));
    expect(card(s)).toMatchObject({ status: 'pending' });
    expect(card(s).settledBy).toBeUndefined();
    expect(card(run(request({ actor: CODER }), trigger('agent.stop', T + 10, { actor: CODER })))).toMatchObject({
      status: 'expired',
      settledBy: 'turn',
    });
  });

  it.each<[string, OfficeEvent, Actor, string]>([
    ['same-actor turn.error (main)', trigger('turn.error', T + 10), MAIN, 'expired'],
    ['same-actor turn.error (coder)', trigger('turn.error', T + 10, { actor: CODER }), CODER, 'expired'],
    ['turn.error of another actor (main error, coder card)', trigger('turn.error', T + 10), CODER, 'pending'],
    ['turn.error of another actor (coder error, main card)', trigger('turn.error', T + 10, { actor: CODER }), MAIN, 'pending'],
    ['turn.stop of another subagent', trigger('turn.stop', T + 10, { actor: ARCH }), CODER, 'pending'],
    ['agent.stop of a different actor', trigger('agent.stop', T + 10, { actor: ARCH }), CODER, 'pending'],
  ])('3. %s', (_n, e, cardActor, status) => {
    expect(card(run(request({ actor: cardActor }), e)).status).toBe(status);
  });

  it('4. a PO prompt settles cards of every actor', () => {
    const s = run(request({ requestId: 'c', actor: CODER }), request({ requestId: 'm' }), po(T + 10));
    expect(card(s, 'c')).toMatchObject({ status: 'expired', settledBy: 'turn' });
    expect(card(s, 'm')).toMatchObject({ status: 'expired', settledBy: 'turn' });
    // also when the prompt event itself comes from a subagent actor
    expect(card(run(request(), po(T + 10, { actor: CODER }))).status).toBe('expired');
  });

  it.each<[string, Partial<OfficeEvent>]>([
    ['<agent-message marker', { text: '<agent-message' }],
    ['<task-notification marker', { text: '<task-notification' }],
    ['side-session phrase', { text: 'Background (from the session that started this one)' }],
    ['no text', { text: undefined }],
  ])('5. prompt.submit with %s leaves cards pending', (_n, over) => {
    const s = run(request({ requestId: 'c', actor: CODER }), request({ requestId: 'm' }), po(T + 10, over));
    expect(card(s, 'c').status).toBe('pending');
    expect(card(s, 'm').status).toBe('pending');
  });

  it('6. actionable cards stay pending through all of the above', () => {
    const s = run(
      actionableReq({ requestId: 'a1' }),
      actionableReq({ requestId: 'a2', actor: CODER }),
      trigger('turn.stop', T + 10),
      trigger('turn.error', T + 11),
      trigger('agent.stop', T + 12, { actor: CODER }),
      trigger('turn.error', T + 13, { actor: CODER }),
      po(T + 14),
    );
    for (const id of ['a1', 'a2']) {
      expect(card(s, id)).toMatchObject({ status: 'pending', actionable: true });
      expect(card(s, id).settledBy).toBeUndefined();
    }
  });

  it.each<[string, OfficeEvent]>([
    ['turn.stop', trigger('turn.stop', T - 1)],
    ['turn.error', trigger('turn.error', T - 1)],
    ['prompt.submit', po(T - 1)],
  ])('7. %s with emittedAt < card.at settles nothing', (_n, e) => {
    expect(card(run(request(), e)).status).toBe('pending');
  });

  it('a PO prompt with a leading BOM/space still counts as the PO', () => {
    expect(card(run(request(), po(T + 10, { text: '\uFEFF  hello' }))).status).toBe('expired');
  });
});

describe('AC4: session.end closes every pending card of the session', () => {
  it('both kinds -> expired/session; decided cards are untouched', () => {
    const s = run(
      request({ requestId: 'info', at: T }),
      actionableReq({ requestId: 'act', at: T + 1 }),
      request({ requestId: 'done', at: T + 2 }),
      resolved('deny', T + 3, 'done'),
      trigger('session.end', T + 10),
    );
    expect(card(s, 'info')).toMatchObject({ status: 'expired', settledBy: 'session' });
    expect(card(s, 'act')).toMatchObject({ status: 'expired', settledBy: 'session' });
    expect(card(s, 'done')).toMatchObject({ status: 'deny', settledBy: 'decision' });
  });

  it('works for a cloud card too, and an event older than the card does not matter for session.end', () => {
    const s = run(request({ source: 'cloud', runId: 'run_9', at: T + 50 }), trigger('session.end', T + 10, { source: 'cloud' }));
    expect(card(s)).toMatchObject({ status: 'expired', settledBy: 'session' });
  });
});

describe('AC5: run.status closes actionable cards of that run only', () => {
  it.each<[string, 'starting' | 'running' | 'exited' | 'stopped' | 'failed', string | undefined, 'pending' | 'expired']>([
    ['exited, same run', 'exited', 'run_1', 'expired'],
    ['stopped, same run', 'stopped', 'run_1', 'expired'],
    ['failed, same run', 'failed', 'run_1', 'expired'],
    ['running, same run', 'running', 'run_1', 'pending'],
    ['starting, same run', 'starting', 'run_1', 'pending'],
    ['exited, other run', 'exited', 'run_2', 'pending'],
    ['exited, no runId on the event', 'exited', undefined, 'pending'],
  ])('%s -> %s', (_n, status, runId, expected) => {
    const e = trigger('run.status', T + 10, { run: { status }, ...(runId ? { runId } : {}) });
    const c = card(run(actionableReq(), e));
    expect(c.status).toBe(expected);
    expect(c.settledBy).toBe(expected === 'expired' ? 'run' : undefined);
  });

  it('a cloud card with a runId is informational, so run.status does not settle it', () => {
    const e = trigger('run.status', T + 10, { source: 'cloud', run: { status: 'exited' }, runId: 'run_1' });
    expect(card(run(request({ source: 'cloud', runId: 'run_1' }), e)).status).toBe('pending');
  });
});

describe('AC6: tickFeed and the 300 s time-to-live', () => {
  it('PERMISSION_TTL_MS is 300 000 and equals the avatar "waiting" cap', () => {
    expect(PERMISSION_TTL_MS).toBe(300_000);
    expect(PERMISSION_TTL_MS).toBe(WAITING_MAX_MS);
    expect(MAX_PINNED).toBe(20);
  });

  it.each([
    ['informational', request()],
    ['actionable', actionableReq()],
  ])('%s: pending at +299 999 ms, expired/timeout at +300 000 ms', (_n, req) => {
    const s = run(req);
    const c = card(s);
    expect(card(tickFeed(s, c.at + PERMISSION_TTL_MS - 1)).status).toBe('pending');
    expect(card(tickFeed(s, c.at + PERMISSION_TTL_MS))).toMatchObject({ status: 'expired', settledBy: 'timeout' });
  });

  it('returns the identical object when nothing changes, and is idempotent', () => {
    const s = run(request(), actionableReq({ requestId: 'r2' }));
    expect(tickFeed(s, T)).toBe(s);
    expect(tickFeed(s, T + PERMISSION_TTL_MS - 1)).toBe(s);
    const ticked = tickFeed(s, T + PERMISSION_TTL_MS);
    expect(ticked).not.toBe(s);
    expect(tickFeed(ticked, T + PERMISSION_TTL_MS)).toBe(ticked);
    expect(tickFeed(ticked, T + 10 * PERMISSION_TTL_MS)).toBe(ticked);
    expect(tickFeed(initialFeedState(), T)).toEqual(initialFeedState());
  });

  it('a result does not depend on how often it ticks', () => {
    const s = run(request());
    let stepped = s;
    for (let t = T; t <= T + PERMISSION_TTL_MS + 5_000; t += 7_000) stepped = tickFeed(stepped, t);
    expect(tickFeed(s, T + PERMISSION_TTL_MS + 5_000)).toEqual(stepped);
  });

  it('reduceFeed ticks first: an event 300 s later expires the card even if it settles nothing', () => {
    const s = run(request(), trigger('notification', T + PERMISSION_TTL_MS, { text: 'late' }));
    expect(card(s)).toMatchObject({ status: 'expired', settledBy: 'timeout' });
    // ...and the time-based expiry wins over the event's own rule when both apply
    const t = run(request(), toolOf('tool.end', T + PERMISSION_TTL_MS));
    expect(card(t).settledBy).toBe('timeout');
  });
});

describe('AC7: a real decision beats an inferred one', () => {
  const settlers: [string, OfficeEvent[]][] = [
    ['timeout', [trigger('notification', T + PERMISSION_TTL_MS, { text: 'late' })]],
    ['activity', [toolOf('tool.end', T + 5)]],
    ['turn', [trigger('turn.stop', T + 5)]],
    ['session', [trigger('session.end', T + 5)]],
  ];

  it.each(settlers)('resolved allow / deny after auto-expiry by %s -> the decision', (_n, events) => {
    for (const d of ['allow', 'deny'] as const) {
      const expired = run(request(), ...events);
      expect(card(expired).status).toBe('expired');
      const s = reduceFeed(expired, resolved(d, T + 400_000));
      expect(card(s)).toMatchObject({ status: d, settledBy: 'decision' });
    }
  });

  it('resolved allow after a bridge-run expiry (run ended) also wins', () => {
    const s = run(actionableReq(), trigger('run.status', T + 5, { run: { status: 'exited' }, runId: 'run_1' }), resolved('allow', T + 6));
    expect(card(s)).toMatchObject({ status: 'allow', settledBy: 'decision' });
  });

  it.each<['allow' | 'deny', 'allow' | 'deny' | 'expired']>([
    ['allow', 'expired'],
    ['allow', 'deny'],
    ['allow', 'allow'],
    ['deny', 'expired'],
    ['deny', 'allow'],
  ])('a card decided %s stays %s-proof: a later resolved %s is a no-op', (first, later) => {
    const s = run(request(), resolved(first, T + 1), resolved(later, T + 2));
    expect(card(s)).toMatchObject({ status: first, settledBy: 'decision' });
  });

  it('resolved expired closes only a pending card; after an inferred expiry it changes nothing', () => {
    expect(card(run(request(), resolved('expired', T + 1)))).toMatchObject({ status: 'expired', settledBy: 'decision' });
    const inferred = run(request(), toolOf('tool.end', T + 5), resolved('expired', T + 6));
    expect(card(inferred)).toMatchObject({ status: 'expired', settledBy: 'activity' });
  });

  it('resolved for an unknown request id, or without a card, changes nothing', () => {
    const s = run(request());
    expect(reduceFeed(s, resolved('allow', T + 1, 'nope')).items).toEqual(s.items);
    // B-06: with no card at all the decision is only remembered, never shown.
    const orphan = reduceFeed(initialFeedState(), resolved('allow', T + 1));
    expect(orphan.items).toEqual([]);
    expect(orphan.orphanDecisions).toEqual([{ requestId: 'r1', decision: 'allow', at: T + 1 }]);
  });
});

describe('B-06: a permission.resolved that arrives before its request', () => {
  it.each<['allow' | 'deny' | 'expired']>([['allow'], ['deny'], ['expired']])('%s settles the card when the request comes later', (d) => {
    const s = run(resolved(d, T + 5), request({ at: T + 5 }));
    expect(card(s)).toMatchObject({ status: d, settledBy: 'decision' });
    expect(s.orphanDecisions).toEqual([]); // dropped once matched
  });

  it('an actionable card is settled the same way', () => {
    expect(card(run(resolved('deny', T + 5), actionableReq({ at: T + 5 }))).status).toBe('deny');
  });

  it('a decision for another request id stays remembered and does not touch the card', () => {
    const s = run(resolved('allow', T + 5, 'other'), request({ at: T + 5 }));
    expect(card(s).status).toBe('pending');
    expect(s.orphanDecisions).toHaveLength(1);
  });

  it('a real decision replaces an orphan expired for the same id; expired never replaces a real one', () => {
    expect(card(run(resolved('expired', T), resolved('allow', T + 1), request({ at: T + 2 }))).status).toBe('allow');
    expect(card(run(resolved('deny', T), resolved('expired', T + 1), request({ at: T + 2 }))).status).toBe('deny');
  });

  it('is bounded: at most 50 orphans, the oldest are dropped', () => {
    const events = Array.from({ length: 80 }, (_v, i) => resolved('allow', T + i, `q${i}`));
    const s = run(...events);
    expect(s.orphanDecisions).toHaveLength(MAX_ORPHAN_DECISIONS);
    expect(MAX_ORPHAN_DECISIONS).toBe(50);
    expect(s.orphanDecisions[0]?.requestId).toBe('q30');
    expect(s.orphanDecisions.at(-1)?.requestId).toBe('q79');
  });

  it('orphans expire after the card TTL (tickFeed), and tickFeed stays idempotent', () => {
    const s = run(resolved('allow', T));
    expect(tickFeed(s, T + PERMISSION_TTL_MS - 1)).toBe(s);
    const later = tickFeed(s, T + PERMISSION_TTL_MS);
    expect(later.orphanDecisions).toEqual([]);
    expect(tickFeed(later, T + PERMISSION_TTL_MS)).toBe(later);
    // an expired orphan no longer settles a late request
    expect(card(reduceFeed(later, request({ at: T + PERMISSION_TTL_MS + 1 }))).status).toBe('pending');
  });

  it('a request that is already settled by a decision ignores a second orphan for it', () => {
    const s = run(request(), resolved('allow', T + 1), resolved('deny', T + 2));
    expect(card(s).status).toBe('allow');
    expect(s.orphanDecisions).toEqual([]);
  });

  it('tie order in the reorder buffer: request sorts before resolved at equal emittedAt, whatever the ids', () => {
    const req = request({ at: T });
    const res = resolved('allow', T);
    // make the resolved id sort BEFORE the request id, so only the kind rule can fix the order
    const lowRes: OfficeEvent = { ...res, id: '0'.repeat(64) };
    const highReq: OfficeEvent = { ...req, id: 'f'.repeat(64) };
    const other: OfficeEvent = { ...trigger('notification', T, { text: 'n' }), id: '8'.repeat(64) };
    expect(compareEvents(highReq, lowRes)).toBeLessThan(0);
    expect(compareEvents(lowRes, highReq)).toBeGreaterThan(0);
    // total order: request < other < resolved, in every input permutation
    const perms = [
      [highReq, lowRes, other],
      [lowRes, other, highReq],
      [other, highReq, lowRes],
      [lowRes, highReq, other],
    ];
    for (const p of perms) expect([...p].sort(compareEvents).map((e) => e.kind)).toEqual(['permission.request', 'notification', 'permission.resolved']);
    // through the buffer: delivered resolved first, released request first, card settles
    let st = bufferPush(initialReorderState(), { ...lowRes, receivedAt: T }, T);
    st = bufferPush(st, { ...highReq, receivedAt: T }, T + 1);
    const d = bufferFlush(st);
    expect(d.ready.map((e) => e.kind)).toEqual(['permission.request', 'permission.resolved']);
    expect(d.late).toBe(0);
    expect(card(d.ready.reduce(reduceFeed, initialFeedState())).status).toBe('allow');
  });

  it('a request released after its resolved (different ms) still settles via the orphan', () => {
    const d = bufferFlush(bufferPush(bufferPush(initialReorderState(), resolved('deny', T + 5), T), request({ at: T + 4 }), T + 1));
    expect(card(d.ready.reduce(reduceFeed, initialFeedState())).status).toBe('deny');
  });
});

describe('AC8: a trigger older than the card does not settle it', () => {
  const early = T - 1;
  it.each<[string, OfficeEvent]>([
    ['tool.end', toolOf('tool.end', early)],
    ['tool.fail', toolOf('tool.fail', early)],
    ['agent.stop', trigger('agent.stop', early, { actor: CODER })],
    ['turn.stop', trigger('turn.stop', early)],
    ['turn.error', trigger('turn.error', early)],
    ['prompt.submit', trigger('prompt.submit', early, { text: 'go' })],
  ])('informational card, %s one ms before the card', (_n, e) => {
    const cardActor = e.kind === 'agent.stop' ? CODER : MAIN;
    expect(card(run(request({ actor: cardActor }), e)).status).toBe('pending');
  });

  it('actionable card, run.status one ms before the card', () => {
    const e = trigger('run.status', early, { run: { status: 'exited' }, runId: 'run_1' });
    expect(card(run(actionableReq(), e)).status).toBe('pending');
  });

  it('the same event at exactly card.at does settle (>=)', () => {
    expect(card(run(request(), toolOf('tool.end', T))).settledBy).toBe('activity');
  });
});

describe('AC9: pinning under the 500-item cap (NB-02)', () => {
  const lines = (n: number, from: number): OfficeEvent[] =>
    Array.from({ length: n }, (_v, i) => trigger('notification', from + i, { text: `n${i}` }));

  it('25 pending actionable cards + 1000 lines -> 500 items, the 20 newest cards kept, no informational card pinned', () => {
    const events: OfficeEvent[] = [];
    // informational cards first, so they would be the oldest if they were pinned
    for (let i = 0; i < 5; i++) events.push(request({ requestId: `info${i}`, at: T + i }));
    for (let i = 0; i < 25; i++) events.push(actionableReq({ requestId: `act${i}`, at: T + 10 + i }));
    events.push(...lines(1000, T + 100));
    const s = run(...events);
    expect(s.items).toHaveLength(MAX_FEED_ITEMS);
    const kept = cards(s).map((c) => c.requestId);
    expect(kept).toEqual(Array.from({ length: MAX_PINNED }, (_v, i) => `act${i + 5}`)); // the 20 newest, in order
    expect(cards(s).every((c) => c.status === 'pending' && c.actionable)).toBe(true);
    // pinned cards stay at the top, in order; the rest are the newest lines
    expect(s.items.slice(0, MAX_PINNED).every((i) => i.type === 'permission')).toBe(true);
    expect(s.items.at(-1)).toMatchObject({ text: 'n999' });
  });

  it('the cap never exceeds 500, even with only pinned cards and a few lines', () => {
    const events: OfficeEvent[] = [];
    for (let i = 0; i < 40; i++) events.push(actionableReq({ requestId: `a${i}`, at: T + i }));
    events.push(...lines(MAX_FEED_ITEMS + 10, T + 100));
    const s = run(...events);
    expect(s.items).toHaveLength(MAX_FEED_ITEMS);
    expect(cards(s)).toHaveLength(MAX_PINNED);
  });

  it('informational pending cards are dropped like any item once they are old', () => {
    const s = run(request({ requestId: 'old', at: T }), ...lines(MAX_FEED_ITEMS + 5, T + 1));
    expect(cards(s)).toHaveLength(0);
    expect(s.items).toHaveLength(MAX_FEED_ITEMS);
  });

  it('a settled actionable card is no longer pinned', () => {
    const events = [actionableReq({ requestId: 'a' }), resolved('allow', T + 1, 'a'), ...lines(MAX_FEED_ITEMS + 5, T + 5)];
    expect(cards(run(...events))).toHaveLength(0);
  });

  it('fewer than 500 items: nothing is dropped, cards keep their position', () => {
    const s = run(...lines(3, T), actionableReq({ at: T + 5 }), ...lines(3, T + 6));
    expect(s.items.map((i) => i.type)).toEqual(['line', 'line', 'line', 'permission', 'line', 'line', 'line']);
  });
});

describe('AC10: replay determinism (shuffled within the 500 ms window)', () => {
  // Small seeded PRNG so the shuffle is reproducible.
  function shuffled<T>(list: readonly T[], seed: number): T[] {
    const out = [...list];
    let x = seed >>> 0 || 1;
    for (let i = out.length - 1; i > 0; i--) {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      const j = x % (i + 1);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }

  function throughBuffer(events: readonly OfficeEvent[]): FeedState {
    let buf = initialReorderState();
    // Receiver clock = the first emittedAt: everything arrives within the 500 ms window
    // and nothing is clamped (events more than 60 s ahead of the receiver would be).
    const arrival = Math.min(...events.map((e) => e.emittedAt));
    for (const e of events) buf = bufferPush(buf, e, arrival);
    const drained = bufferDrain(buf, arrival + REORDER_WINDOW_MS);
    expect(bufferFlush(drained.state).ready).toHaveLength(0);
    return drained.ready.reduce(reduceFeed, initialFeedState());
  }

  it.each([['pc2'], ['pc-desktop'], ['pc']] as const)('observed %s session: any delivery order gives the same feed', async (set) => {
    const all = await observedTimeline(set, 2_000_000, 10);
    const mainSession = all.find((e) => e.kind === 'prompt.submit' && !e.text?.startsWith('Background'))?.sessionId;
    const events = all.filter((e) => e.sessionId === mainSession);
    const ordered = events.reduce(reduceFeed, initialFeedState());
    expect(ordered.items.length).toBeGreaterThan(3);
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(throughBuffer(shuffled(events, seed)), `seed ${seed}`).toEqual(ordered);
    }
  });

  it('synthetic cards, results and triggers: any order gives the same feed', () => {
    const events: OfficeEvent[] = [
      request({ requestId: 'a', at: T }),
      actionableReq({ requestId: 'b', at: T + 5 }),
      toolOf('tool.end', T + 20),
      resolved('allow', T + 30, 'b'),
      trigger('turn.stop', T + 40),
      request({ requestId: 'c', at: T + 50 }),
      trigger('session.end', T + 60),
    ].map((e, i) => ({ ...e, id: hexId(900 + i) }));
    const ordered = events.reduce(reduceFeed, initialFeedState());
    for (let seed = 1; seed <= 20; seed++) expect(throughBuffer(shuffled(events, seed)), `seed ${seed}`).toEqual(ordered);
    // The test has teeth: without the buffer, some delivery orders do give another feed.
    const raw = Array.from({ length: 20 }, (_v, i) => shuffled(events, i + 1).reduce(reduceFeed, initialFeedState()));
    expect(raw.some((f) => JSON.stringify(f) !== JSON.stringify(ordered))).toBe(true);
    expect(cards(ordered).map((c) => [c.requestId, c.status, c.settledBy])).toEqual([
      ['a', 'expired', 'activity'],
      ['b', 'allow', 'decision'],
      ['c', 'expired', 'session'],
    ]);
  });
});

describe('purity', () => {
  it('reduceFeed and tickFeed never mutate their input', () => {
    const s = run(request(), actionableReq({ requestId: 'r2' }));
    const snapshot = JSON.stringify(s);
    Object.freeze(s.items);
    for (const c of s.items) Object.freeze(c);
    reduceFeed(s, toolOf('tool.end', T + 5));
    reduceFeed(s, resolved('allow', T + 6));
    tickFeed(s, T + PERMISSION_TTL_MS);
    expect(JSON.stringify(s)).toBe(snapshot);
  });

  it('items are plain data (no functions), so state can be serialised', () => {
    const s = run(request(), toolOf('tool.end', T + 1));
    const item: FeedItem | undefined = s.items[0];
    expect(JSON.parse(JSON.stringify(item))).toEqual(item);
  });
});
