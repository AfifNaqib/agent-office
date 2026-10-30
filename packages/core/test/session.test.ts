import { describe, expect, it } from 'vitest';
import { IDLE_AFTER_MS, initialOfficeState, reduce, tick } from '../src/reducers/avatar.js';
import { initialFeedState, reduceFeed } from '../src/reducers/feed.js';
import {
  MAX_FUTURE_SKEW_MS,
  MAX_PAST_SKEW_MS,
  REORDER_WINDOW_MS,
  SEEN_MAX,
  SESSION_IDLE_AFTER_MS,
  bufferDrain,
  bufferFlush,
  bufferPush,
  clampEmittedAt,
  claudeCodeUrl,
  compareEvents,
  initialReorderState,
  initialSessionsState,
  lobby,
  nextDrainAt,
  reduceSessions,
  sessionKey,
  type ReorderState,
} from '../src/reducers/session.js';
import type { OfficeEvent } from '../src/schema.js';
import { ARCH, CODER, EXPLORE, MAIN, TESTER, deepFreeze, ev, hexId } from './helpers/events.js';
import { fixtureTimeline } from './helpers/fixtures.js';

const T = 30_000_000;
const sessions = (...events: OfficeEvent[]) => events.reduce(reduceSessions, initialSessionsState());

describe('session reducer (FR-011, FR-016)', () => {
  it('creates one entry per source:sessionId with first-seen repo/run/remote ids', () => {
    const s = sessions(
      ev('session.start', { emittedAt: T, sessionId: 'a', repo: 'portfolio' }),
      ev('tool.start', { emittedAt: T + 5, sessionId: 'a', runId: 'run_1', repo: 'other' }),
      ev('session.start', { emittedAt: T + 1, sessionId: 'a', source: 'cloud', remoteSessionId: 'cse_ABC123' }),
    );
    expect(Object.keys(s.sessions).sort()).toEqual(['cloud:a', 'local:a']);
    expect(s.sessions['local:a']).toMatchObject({ repo: 'portfolio', runId: 'run_1', startedAt: T, lastEventAt: T + 5, eventCount: 2, endedAt: null });
    expect(s.sessions['cloud:a']).toMatchObject({ remoteSessionId: 'cse_ABC123', repo: null, runId: null });
    expect(sessionKey({ source: 'cloud', sessionId: 'x' })).toBe('cloud:x');
  });

  it('status: live, then idle after 120 s, ended on session.end', () => {
    const s = sessions(ev('prompt.submit', { emittedAt: T, sessionId: 'a' }));
    expect(lobby(s, T + SESSION_IDLE_AFTER_MS - 1)[0]?.status).toBe('live');
    expect(lobby(s, T + SESSION_IDLE_AFTER_MS)[0]?.status).toBe('idle');
    const ended = reduceSessions(s, ev('session.end', { emittedAt: T + 10, sessionId: 'a' }));
    expect(lobby(ended, T + 11)[0]).toMatchObject({ status: 'ended', endedAt: T + 10 });
  });

  it('a late event from before the end does not reopen it; a newer one (resume) does', () => {
    const s = sessions(ev('session.start', { emittedAt: T, sessionId: 'a' }), ev('session.end', { emittedAt: T + 10, sessionId: 'a' }));
    const late = reduceSessions(s, ev('tool.end', { emittedAt: T + 5, sessionId: 'a' }));
    expect(lobby(late, T + 20)[0]?.status).toBe('ended');
    const resumed = reduceSessions(s, ev('session.start', { emittedAt: T + 50, sessionId: 'a' }));
    expect(lobby(resumed, T + 60)[0]).toMatchObject({ status: 'live', endedAt: null });
  });

  it('controllable only when bridge-owned (runId) and not ended', () => {
    const s = sessions(ev('session.start', { emittedAt: T, sessionId: 'r', runId: 'run_9' }), ev('session.start', { emittedAt: T, sessionId: 'n' }));
    const byKey = Object.fromEntries(lobby(s, T + 1).map((e) => [e.key, e]));
    expect(byKey['local:r']?.controllable).toBe(true);
    expect(byKey['local:n']?.controllable).toBe(false);
    const ended = reduceSessions(s, ev('session.end', { emittedAt: T + 2, sessionId: 'r', runId: 'run_9' }));
    expect(lobby(ended, T + 3).find((e) => e.key === 'local:r')?.controllable).toBe(false);
  });

  it('BUG-09: a cloud session with a runId is not controllable (only local bridge runs are)', () => {
    const s = sessions(ev('notification', { source: 'cloud', sessionId: 'c', runId: 'r1', remoteSessionId: 'cse_abc', text: 'x', emittedAt: T }));
    expect(lobby(s, T + 1)[0]).toMatchObject({ key: 'cloud:c', runId: 'r1', controllable: false });
  });

  it('cloud sessions get the "Open in Claude" deep link with cse_ -> session_', () => {
    expect(claudeCodeUrl('cse_01AbC')).toBe('https://claude.ai/code/session_01AbC');
    expect(claudeCodeUrl('session_01AbC')).toBe('https://claude.ai/code/session_01AbC');
    const s = sessions(
      ev('session.start', { emittedAt: T, sessionId: 'c', source: 'cloud', remoteSessionId: 'cse_XYZ' }),
      ev('session.start', { emittedAt: T, sessionId: 'l' }),
    );
    const urls = Object.fromEntries(lobby(s, T).map((e) => [e.key, e.openUrl]));
    expect(urls).toEqual({ 'cloud:c': 'https://claude.ai/code/session_XYZ', 'local:l': null });
  });

  it('lobby is sorted by last activity, newest first, ties by key', () => {
    const s = sessions(
      ev('session.start', { emittedAt: T + 1, sessionId: 'old' }),
      ev('session.start', { emittedAt: T + 9, sessionId: 'new' }),
      ev('session.start', { emittedAt: T + 5, sessionId: 'b' }),
      ev('session.start', { emittedAt: T + 5, sessionId: 'a' }),
    );
    expect(lobby(s, T + 10).map((e) => e.sessionId)).toEqual(['new', 'a', 'b', 'old']);
  });
});

describe('reorder buffer basics', () => {
  const at = (id: number, emittedAt: number) => ev('notification', { id: hexId(id), emittedAt });

  it('holds events for 500 ms after arrival, then releases them in (emittedAt, id) order', () => {
    let b = initialReorderState();
    b = bufferPush(b, at(2, 200), 0);
    b = bufferPush(b, at(1, 100), 100);
    b = bufferPush(b, at(3, 200), 150); // same emittedAt as #2 -> id breaks the tie
    expect(nextDrainAt(b)).toBe(REORDER_WINDOW_MS);
    expect(bufferDrain(b, REORDER_WINDOW_MS - 1).ready).toEqual([]);
    const d = bufferDrain(b, REORDER_WINDOW_MS);
    // #2 is due; #1 sorts before it, so it comes out too. #3 waits.
    expect(d.ready.map((e) => e.id)).toEqual([hexId(1), hexId(2)]);
    expect(d.state.pending).toHaveLength(1);
    const d2 = bufferDrain(d.state, 650);
    expect(d2.ready.map((e) => e.id)).toEqual([hexId(3)]);
    expect(nextDrainAt(d2.state)).toBeNull();
  });

  it('drops duplicate ids, including ones already released', () => {
    let b = bufferPush(initialReorderState(), at(1, 10), 0);
    b = bufferPush(b, at(1, 10), 1);
    expect(b.pending).toHaveLength(1);
    const d = bufferFlush(b);
    expect(bufferPush(d.state, at(1, 10), 2)).toBe(d.state);
  });

  it('an event that arrives after a later one was released is released on the next drain and counted late', () => {
    const d = bufferFlush(bufferPush(initialReorderState(), at(2, 200), 0));
    const b = bufferPush(d.state, at(1, 100), 1000);
    expect(nextDrainAt(b)).toBe(1000);
    const d2 = bufferDrain(b, 1000);
    expect(d2.ready.map((e) => e.id)).toEqual([hexId(1)]);
    expect(d2.late).toBe(1);
    expect(d2.state.last).toEqual({ 'local:s1': { emittedAt: 200, id: hexId(2), kind: expect.any(String) as unknown } });
  });

  it('flush on an empty buffer is a no-op; the seen list is bounded', () => {
    const empty = initialReorderState();
    expect(bufferFlush(empty)).toEqual({ state: empty, ready: [], late: 0 });
    let b = empty;
    for (let i = 0; i < SEEN_MAX + 5; i++) b = bufferFlush(bufferPush(b, at(i + 1, i), i)).state;
    expect(b.seen).toHaveLength(SEEN_MAX);
  });

  it('compareEvents orders by emittedAt, then id', () => {
    expect(compareEvents({ emittedAt: 1, id: 'b' }, { emittedAt: 2, id: 'a' })).toBeLessThan(0);
    expect(compareEvents({ emittedAt: 2, id: 'b' }, { emittedAt: 2, id: 'a' })).toBeGreaterThan(0);
    expect(compareEvents({ emittedAt: 2, id: 'a' }, { emittedAt: 2, id: 'a' })).toBe(0);
  });

  it('never mutates its input', () => {
    const b = deepFreeze(bufferPush(bufferPush(initialReorderState(), at(2, 2), 0), at(1, 1), 0));
    expect(() => {
      bufferDrain(b, 10_000);
      bufferFlush(b);
      bufferPush(b, at(3, 3), 1);
    }).not.toThrow();
  });
});

describe('BUG-04: per-session ordering and emittedAt clamp', () => {
  const NOW = 2_000_000_000;
  const e = (n: number, over: Partial<OfficeEvent>) => ev('notification', { id: hexId(n), text: 'x', ...over });

  it('clampEmittedAt: future bounded by receivedAt (or now), past only by receivedAt', () => {
    const fut = e(1, { emittedAt: 9e15 });
    expect(clampEmittedAt(fut, NOW).emittedAt).toBe(NOW + MAX_FUTURE_SKEW_MS);
    expect(clampEmittedAt({ ...fut, receivedAt: NOW - 10 }, NOW).emittedAt).toBe(NOW - 10 + MAX_FUTURE_SKEW_MS);
    expect(clampEmittedAt(e(2, { emittedAt: 0, receivedAt: NOW }), NOW).emittedAt).toBe(NOW - MAX_PAST_SKEW_MS);
    const hist = e(3, { emittedAt: 5 });
    expect(clampEmittedAt(hist, NOW)).toBe(hist); // no receivedAt: history keeps its time
    const ok = e(4, { emittedAt: NOW + 1000 });
    expect(clampEmittedAt(ok, NOW)).toBe(ok);
  });

  it('a session with a clock 5 s ahead does not disable reordering for another session', () => {
    let b = bufferPush(initialReorderState(), e(10, { source: 'cloud', sessionId: 'c1', emittedAt: NOW + 5000 }), NOW);
    b = bufferDrain(b, NOW + 600).state; // cloud event released
    const p1 = e(11, { sessionId: 'p', emittedAt: NOW + 100 });
    const p2 = e(12, { sessionId: 'p', emittedAt: NOW + 200 });
    b = bufferPush(b, p2, NOW + 700);
    let d = bufferDrain(b, NOW + 700);
    expect(d.ready).toEqual([]); // held, not released as "late"
    b = bufferPush(d.state, p1, NOW + 750);
    d = bufferDrain(b, NOW + 1200);
    expect(d.ready.map((x) => x.id)).toEqual([p1.id, p2.id]);
    expect(d.late).toBe(0);
  });

  it('one 9e15 emittedAt neither blocks other sessions nor breaks the 120 s quiet rule', () => {
    let b = bufferPush(initialReorderState(), e(20, { sessionId: 'evil', emittedAt: 9e15 }), NOW);
    let d = bufferDrain(b, NOW + REORDER_WINDOW_MS);
    expect(d.ready[0]?.emittedAt).toBe(NOW + MAX_FUTURE_SKEW_MS);
    let office = d.ready.reduce(reduce, initialOfficeState());
    // Another session keeps reordering.
    // tool.end without a start: an instant action, so no open work (A2.1) exempts the avatar from the quiet rule.
    const a1 = ev('tool.end', { id: hexId(21), sessionId: 'ok', emittedAt: NOW + 1000, actor: CODER, tool: { name: 'Bash', useId: 'u1', summary: 'npm test' } });
    const a0 = ev('prompt.submit', { id: hexId(22), sessionId: 'ok', emittedAt: NOW + 900, text: 'go' });
    b = bufferPush(d.state, a1, NOW + 1100);
    d = bufferDrain(b, NOW + 1100);
    expect(d.ready).toEqual([]);
    b = bufferPush(d.state, a0, NOW + 1200);
    d = bufferDrain(b, NOW + 1700);
    expect(d.ready.map((x) => x.id)).toEqual([a0.id, a1.id]);
    office = d.ready.reduce(reduce, office);
    expect(office.avatars.coder?.activity).toBe('running');
    expect(office.lastEventAt).toBe(NOW + MAX_FUTURE_SKEW_MS);
    // Quiet rule: at most MAX_FUTURE_SKEW_MS later than without the bad event.
    const idle = tick(office, NOW + MAX_FUTURE_SKEW_MS + IDLE_AFTER_MS);
    expect(idle.avatars.coder?.activity).toBe('idle');
  });

  it('a late event only flushes its own session', () => {
    let b = bufferFlush(bufferPush(initialReorderState(), e(30, { sessionId: 'a', emittedAt: NOW + 500 }), NOW)).state;
    b = bufferPush(b, e(31, { sessionId: 'b', emittedAt: NOW + 100 }), NOW + 10); // b: in its window
    b = bufferPush(b, e(32, { sessionId: 'a', emittedAt: NOW + 200 }), NOW + 20); // a: late
    expect(nextDrainAt(b)).toBe(NOW + 20);
    const d = bufferDrain(b, NOW + 20);
    expect(d.ready.map((x) => x.id)).toEqual([hexId(32)]);
    expect(d.late).toBe(1);
    expect(d.state.pending.map((p) => p.event.id)).toEqual([hexId(31)]);
  });
});

// ---- C-06 AC: shuffled delivery within 500 ms -> the same final state ----

/** Seeded PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A realistic team run: delegations, parallel tools, a permission, failures, two sessions. */
function teamRun(t0: number): OfficeEvent[] {
  const out: OfficeEvent[] = [];
  let t = t0;
  let id = 1000;
  const add = (kind: OfficeEvent['kind'], over: Partial<OfficeEvent> = {}, dt = 40) => {
    t += dt;
    out.push(ev(kind, { id: hexId(++id), emittedAt: t, ...over }));
  };
  const toolPair = (actor: typeof MAIN, name: string, summary: string, n: number) => {
    const u = `toolu_${n}`;
    add('tool.start', { actor, tool: { name, useId: u, summary } }, 30);
    add('tool.end', { actor, tool: { name, useId: u, summary } }, 20);
  };
  add('session.start', { repo: 'portfolio' });
  add('prompt.submit', { text: 'plan and test it' });
  add('tool.start', { tool: { name: 'Agent', useId: 'ag1', summary: 'architect: Plan' } });
  add('agent.start', { actor: ARCH });
  for (let i = 0; i < 5; i++) toolPair(ARCH, i % 2 ? 'Grep' : 'Read', `f${i}`, i);
  add('agent.stop', { actor: ARCH, text: 'plan ready' });
  add('tool.end', { tool: { name: 'Agent', useId: 'ag1', summary: 'architect: Plan' } });
  add('tool.start', { tool: { name: 'Agent', useId: 'ag2', summary: 'tester: Test' } });
  add('agent.start', { actor: TESTER });
  add('agent.start', { actor: EXPLORE }, 5);
  for (let i = 10; i < 16; i++) toolPair(i % 2 ? TESTER : EXPLORE, i % 3 ? 'Bash' : 'Glob', `c${i}`, i);
  add('tool.start', { actor: TESTER, tool: { name: 'Bash', useId: 'toolu_fail', summary: 'node -e' } });
  add('permission.request', { actor: TESTER, permission: { requestId: 'req1', toolName: 'Bash', summary: 'node -e' } }, 1);
  add('permission.resolved', { actor: TESTER, permission: { requestId: 'req1', toolName: 'Bash', summary: 'node -e', decision: 'allow' } });
  add('tool.fail', { actor: TESTER, tool: { name: 'Bash', useId: 'toolu_fail', summary: 'node -e' }, text: 'Exit code 3' });
  add('session.start', { sessionId: 'other', source: 'cloud', remoteSessionId: 'cse_Z' }, 1);
  add('agent.stop', { actor: EXPLORE });
  add('agent.stop', { actor: TESTER, text: 'SHIP' });
  for (let i = 20; i < 25; i++) toolPair(CODER, 'Edit', `e${i}`, i);
  add('turn.stop', { text: 'all done' });
  add('session.end', {}, 200);
  return out;
}

interface World {
  office: ReturnType<typeof initialOfficeState>;
  feed: ReturnType<typeof initialFeedState>;
  sessions: ReturnType<typeof initialSessionsState>;
}
const emptyWorld = (): World => ({ office: initialOfficeState(), feed: initialFeedState(), sessions: initialSessionsState() });
const applyAll = (w: World, events: readonly OfficeEvent[]): World =>
  events.reduce<World>(
    (acc, e) => ({ office: reduce(acc.office, e), feed: reduceFeed(acc.feed, e), sessions: reduceSessions(acc.sessions, e) }),
    w,
  );

type Worlds = Record<string, World>;

/** BUG-04: ordering is guaranteed per session, so each session gets its own world (feed/office/lobby). */
const applyPerSession = (ws: Worlds, events: readonly OfficeEvent[]): Worlds => {
  const out = { ...ws };
  for (const e of events) {
    const k = sessionKey(e);
    out[k] = applyAll(out[k] ?? emptyWorld(), [e]);
  }
  return out;
};

/**
 * Deliver `events` with each one's arrival delayed by a random 0..maxDelay ms
 * after its emittedAt, optionally duplicated, draining at every arrival and at
 * every scheduled drain time, like the UI timer would.
 */
function deliverShuffled(events: readonly OfficeEvent[], seed: number, maxDelay: number, dupRate: number): { worlds: Worlds; late: number } {
  const r = rng(seed);
  const arrivals: { e: OfficeEvent; at: number }[] = [];
  for (const e of events) {
    arrivals.push({ e, at: e.emittedAt + Math.floor(r() * (maxDelay + 1)) });
    if (r() < dupRate) arrivals.push({ e, at: e.emittedAt + Math.floor(r() * (maxDelay + 1)) });
  }
  arrivals.sort((a, b) => a.at - b.at || (r() < 0.5 ? -1 : 1));
  let buf: ReorderState = initialReorderState();
  let worlds: Worlds = {};
  let late = 0;
  const drainUntil = (now: number) => {
    for (let due = nextDrainAt(buf); due !== null && due <= now; due = nextDrainAt(buf)) {
      const d = bufferDrain(buf, due);
      buf = d.state;
      late += d.late;
      worlds = applyPerSession(worlds, d.ready);
    }
  };
  for (const a of arrivals) {
    drainUntil(a.at);
    buf = bufferPush(buf, a.e, a.at);
    const d = bufferDrain(buf, a.at);
    buf = d.state;
    late += d.late;
    worlds = applyPerSession(worlds, d.ready);
  }
  drainUntil(Number.MAX_SAFE_INTEGER);
  return { worlds, late };
}

describe('C-06 AC: shuffled delivery within 500 ms == ordered delivery', () => {
  const events = teamRun(T);
  const orderedAll = applyAll(emptyWorld(), [...events].sort(compareEvents));
  const ordered = applyPerSession({}, [...events].sort(compareEvents));
  const END = events.at(-1)?.emittedAt ?? T;

  it('the scenario is non-trivial (sanity)', () => {
    expect(events.length).toBeGreaterThanOrEqual(50);
    expect(Object.keys(ordered).sort()).toEqual(['cloud:other', 'local:s1']);
    expect(ordered['local:s1']?.feed.items.some((i) => i.type === 'group')).toBe(true);
  });

  it.each(Array.from({ length: 200 }, (_, i) => i + 1))('seed %i: same office, feed and lobby per session', (seed) => {
    const { worlds, late } = deliverShuffled(events, seed, REORDER_WINDOW_MS - 1, 0.2);
    expect(late).toBe(0);
    expect(Object.keys(worlds).sort()).toEqual(Object.keys(ordered).sort());
    for (const [k, want] of Object.entries(ordered)) {
      const world = worlds[k] ?? emptyWorld();
      expect(world.office).toEqual(want.office);
      expect(world.feed).toEqual(want.feed);
      expect(world.sessions).toEqual(want.sessions);
      expect(tick(world.office, END + 200_000)).toEqual(tick(want.office, END + 200_000));
      expect(lobby(world.sessions, END + 1)).toEqual(lobby(want.sessions, END + 1));
    }
  });

  it('control: without the buffer, shuffled delivery does give a different state', () => {
    const r = rng(7);
    const shuffled = [...events].sort(() => r() - 0.5);
    const raw = applyAll(emptyWorld(), shuffled);
    expect(raw.feed).not.toEqual(orderedAll.feed);
  });

  it('delays above the window can be late; they are counted, never dropped', () => {
    const { worlds, late } = deliverShuffled(events, 3, 3000, 0);
    expect(late).toBeGreaterThan(0);
    const total = Object.values(worlds).reduce((n, w) => n + Object.values(w.sessions.sessions).reduce((m, s) => m + s.eventCount, 0), 0);
    expect(total).toBe(events.length);
  });

  // Uses fixtures/hooks/provisional: PROVISIONAL – from docs, not observed.
  it('provisional fixture timeline: shuffled within the window == ordered', async () => {
    const fx = await fixtureTimeline('provisional', T, 60);
    const want = applyPerSession({}, fx);
    for (let seed = 1; seed <= 25; seed++) {
      const { worlds } = deliverShuffled(fx, seed, REORDER_WINDOW_MS - 1, 0.3);
      expect(worlds).toEqual(want);
    }
  });
});
