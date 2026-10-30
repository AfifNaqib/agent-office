import { describe, expect, it } from 'vitest';
import {
  ERROR_MS,
  IDLE_AFTER_MS,
  INSTANT_MS,
  OPEN_WORK_MAX_MS,
  WAITING_MAX_MS,
  MAIN_KEY,
  RECENT_ENDED_MAX,
  avatarKey,
  initialOfficeState,
  reduce,
  tick,
  type OfficeState,
} from '../src/reducers/avatar.js';
import { EVENT_KINDS, type Actor, type EventKind } from '../src/schema.js';
import type { Activity } from '../src/toolActivity.js';
import { ARCH, CODER, EXPLORE, MAIN, TESTER, deepFreeze, ev } from './helpers/events.js';
import { fixtureTimeline, observedTimeline, type FixtureSet } from './helpers/fixtures.js';

const T = 10_000_000;
const apply = (s: OfficeState, ...events: Parameters<typeof reduce>[1][]) => events.reduce(reduce, s);

describe('avatarKey (FR-007)', () => {
  it.each<[Actor, string]>([
    [MAIN, 'main'],
    [ARCH, 'architect'],
    [CODER, 'coder'],
    [{ kind: 'subagent', agentType: 'tester', agentId: null }, 'tester'],
    [{ kind: 'subagent', agentType: 'manager', agentId: null }, 'manager'],
    [EXPLORE, 'visitor:Explore'],
    [{ kind: 'subagent', agentType: 'my-plugin:reviewer', agentId: 'x' }, 'visitor:my-plugin:reviewer'],
    [{ kind: 'subagent', agentType: 'Architect', agentId: 'x' }, 'visitor:Architect'],
  ])('%j -> %s', (actor, key) => {
    expect(avatarKey(actor)).toBe(key);
  });
});

describe('initial state', () => {
  it('has JEBON and the 4 desk agents, idle, and no visitors', () => {
    const s = initialOfficeState();
    expect(Object.keys(s.avatars).sort()).toEqual(['architect', 'coder', 'main', 'manager', 'tester']);
    expect(s.avatars[MAIN_KEY]).toMatchObject({ label: 'JEBON', role: 'lead', activity: 'idle' });
    expect(s.avatars.coder).toMatchObject({ role: 'desk', label: 'coder', activity: 'idle' });
  });
});

// Every kind x actor (main, desk agent, visitor), starting from a fresh state.
const EXPECTED: Record<EventKind, Activity> = {
  'session.start': 'idle',
  'session.end': 'idle',
  'prompt.submit': 'working',
  'agent.start': 'working',
  'agent.stop': 'done',
  'tool.start': 'reading', // helper uses a Read tool
  'tool.end': 'reading', // no matching start -> instant action
  'tool.fail': 'error',
  'permission.request': 'waiting',
  'permission.resolved': 'idle', // nothing was waiting -> unchanged
  notification: 'idle',
  'turn.stop': 'done',
  'turn.error': 'error',
  'run.status': 'idle',
};

describe('reduce: every kind x actor', () => {
  const actors: [string, Actor, string][] = [
    ['main', MAIN, 'main'],
    ['architect', ARCH, 'architect'],
    ['coder', CODER, 'coder'],
    ['tester', TESTER, 'tester'],
    ['manager', { kind: 'subagent', agentType: 'manager', agentId: 'agent-mgr' }, 'manager'],
    ['visitor', EXPLORE, 'visitor:Explore'],
  ];
  const rows = EVENT_KINDS.flatMap((kind) => actors.map(([n, actor, key]) => [kind, n, actor, key] as const));

  it('covers all 14 kinds', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...EVENT_KINDS].sort());
  });

  it.each(rows)('%s by %s', (kind, _n, actor, key) => {
    const s = reduce(initialOfficeState(), ev(kind, { actor, emittedAt: T }));
    const a = s.avatars[key];
    if (kind === 'session.end' && key.startsWith('visitor:')) {
      expect(a).toBeUndefined(); // session.end never creates avatars
      return;
    }
    expect(a?.activity).toBe(EXPECTED[kind]);
    expect(s.lastEventAt).toBe(T);
  });
});

describe('reduce: tool lifecycle', () => {
  it('start -> end returns to working; tool cleared', () => {
    const s = apply(
      initialOfficeState(),
      ev('tool.start', { actor: CODER, emittedAt: T, tool: { name: 'Edit', useId: 'u1', summary: 'src/a.ts' } }),
    );
    expect(s.avatars.coder).toMatchObject({ activity: 'typing', instant: false, tool: { name: 'Edit', summary: 'src/a.ts' }, openTools: ['u1'] });
    const s2 = reduce(s, ev('tool.end', { actor: CODER, emittedAt: T + 5, tool: { name: 'Edit', useId: 'u1', summary: 'src/a.ts' } }));
    expect(s2.avatars.coder).toMatchObject({ activity: 'working', tool: null, openTools: [] });
  });

  it('out-of-order tool.end (no start yet) is an instant action, and the late start is ignored', () => {
    const tool = { name: 'Bash', useId: 'u9', summary: 'npm test' };
    const s = reduce(initialOfficeState(), ev('tool.end', { actor: CODER, emittedAt: T, tool }));
    expect(s.avatars.coder).toMatchObject({ activity: 'running', instant: true });
    const s2 = reduce(s, ev('tool.start', { actor: CODER, emittedAt: T - 3, tool }));
    expect(s2.avatars.coder).toBe(s.avatars.coder);
    expect(s2.avatars.coder?.openTools).toEqual([]);
  });

  it('tool.end without useId is instant', () => {
    const s = reduce(initialOfficeState(), ev('tool.end', { emittedAt: T, tool: { name: 'WebFetch', summary: 'x.com' } }));
    expect(s.avatars.main).toMatchObject({ activity: 'browsing', instant: true });
  });

  it('parallel tools: the avatar keeps working until the last one ends', () => {
    const a = { name: 'Read', useId: 'a', summary: 'x' };
    const b = { name: 'Grep', useId: 'b', summary: 'y' };
    const s = apply(
      initialOfficeState(),
      ev('tool.start', { actor: ARCH, emittedAt: T, tool: a }),
      ev('tool.start', { actor: ARCH, emittedAt: T + 1, tool: b }),
      ev('tool.end', { actor: ARCH, emittedAt: T + 2, tool: a }),
    );
    expect(s.avatars.architect).toMatchObject({ activity: 'reading', openTools: ['b'] });
    const s2 = reduce(s, ev('tool.end', { actor: ARCH, emittedAt: T + 3, tool: b }));
    expect(s2.avatars.architect).toMatchObject({ activity: 'working', openTools: [] });
  });

  it('activity per tool name follows FR-008', () => {
    const cases: [string, Activity][] = [
      ['Glob', 'reading'],
      ['Write', 'typing'],
      ['PowerShell', 'running'],
      ['WebSearch', 'browsing'],
      ['Agent', 'delegating'],
      ['mcp__x__y', 'working'],
    ];
    for (const [name, activity] of cases) {
      const s = reduce(initialOfficeState(), ev('tool.start', { emittedAt: T, tool: { name, useId: 'u', summary: '' } }));
      expect(s.avatars.main?.activity, name).toBe(activity);
    }
  });

  it('tool.fail -> error for 2 s, then idle', () => {
    const s = reduce(initialOfficeState(), ev('tool.fail', { actor: CODER, emittedAt: T }));
    expect(s.avatars.coder).toMatchObject({ activity: 'error', errorUntil: T + ERROR_MS });
    expect(tick(s, T + ERROR_MS - 1).avatars.coder?.activity).toBe('error');
    expect(tick(s, T + ERROR_MS).avatars.coder?.activity).toBe('idle');
  });

  it('turn.error -> error for 2 s, then idle (expiry also applies inside reduce)', () => {
    const s = reduce(initialOfficeState(), ev('turn.error', { emittedAt: T }));
    const s2 = reduce(s, ev('notification', { actor: CODER, emittedAt: T + ERROR_MS + 1 }));
    expect(s2.avatars.main?.activity).toBe('idle');
  });

  it('recentEnded is bounded', () => {
    let s = initialOfficeState();
    for (let i = 0; i < RECENT_ENDED_MAX + 10; i++) {
      s = reduce(s, ev('tool.end', { emittedAt: T + i, tool: { name: 'Read', useId: `u${i}`, summary: '' } }));
    }
    expect(s.avatars.main?.recentEnded).toHaveLength(RECENT_ENDED_MAX);
  });
});

describe('reduce: agents, visitors, permissions, session', () => {
  it('unknown agentType becomes a labelled visitor', () => {
    const s = reduce(initialOfficeState(), ev('agent.start', { actor: EXPLORE, emittedAt: T }));
    expect(s.avatars['visitor:Explore']).toMatchObject({ role: 'visitor', label: 'Explore', present: true, activity: 'working' });
  });

  it('JEBON delegates, architect works and finishes', () => {
    const s = apply(
      initialOfficeState(),
      ev('prompt.submit', { emittedAt: T }),
      ev('tool.start', { emittedAt: T + 1, tool: { name: 'Agent', useId: 'ag', summary: 'architect: plan' } }),
      ev('agent.start', { actor: ARCH, emittedAt: T + 2 }),
      ev('agent.stop', { actor: ARCH, emittedAt: T + 3 }),
    );
    expect(s.avatars.main?.activity).toBe('delegating');
    expect(s.avatars.architect).toMatchObject({ activity: 'done', agentId: 'agent-arch' });
  });

  it('permission request -> waiting; resolved -> working', () => {
    const s = reduce(initialOfficeState(), ev('permission.request', { actor: CODER, emittedAt: T }));
    expect(s.avatars.coder).toMatchObject({ activity: 'waiting', tool: { name: 'Bash', summary: 'rm -rf' } });
    const s2 = reduce(s, ev('permission.resolved', { actor: CODER, emittedAt: T + 1 }));
    expect(s2.avatars.coder?.activity).toBe('working');
  });

  it('session.end idles everyone and visitors leave', () => {
    const s = apply(
      initialOfficeState(),
      ev('agent.start', { actor: EXPLORE, emittedAt: T }),
      ev('tool.start', { actor: CODER, emittedAt: T + 1 }),
      ev('session.end', { emittedAt: T + 2 }),
    );
    expect(Object.values(s.avatars).every((a) => a.activity === 'idle')).toBe(true);
    expect(s.avatars['visitor:Explore']?.present).toBe(false);
    expect(s.avatars.coder?.openTools).toEqual([]);
  });

  it('agentId is updated when a new instance of the same desk agent appears', () => {
    const s = apply(
      initialOfficeState(),
      ev('agent.start', { actor: CODER, emittedAt: T }),
      ev('agent.start', { actor: { ...CODER, agentId: 'agent-code-2' }, emittedAt: T + 1 }),
    );
    expect(s.avatars.coder?.agentId).toBe('agent-code-2');
  });
});

describe('tick: 120 s with no events -> idle', () => {
  // No open work here (A2.1 exempts open tools / open agent runs from this rule; see the A2.1 tests).
  const busy = () =>
    apply(
      initialOfficeState(),
      ev('tool.start', { actor: CODER, emittedAt: T, tool: { name: 'Bash', useId: 'b', summary: 'npm test' } }),
      ev('tool.end', { actor: CODER, emittedAt: T, tool: { name: 'Bash', useId: 'b', summary: 'npm test' } }),
      ev('prompt.submit', { actor: EXPLORE, emittedAt: T }),
      ev('permission.request', { actor: ARCH, emittedAt: T }),
    );

  it('nothing changes before 120 s (same object returned)', () => {
    const s = busy();
    expect(tick(s, T + IDLE_AFTER_MS - 1)).toBe(s);
  });

  it('at 120 s everyone goes idle, visitors leave, waiting stays waiting', () => {
    const s = tick(busy(), T + IDLE_AFTER_MS);
    expect(s.avatars.coder).toMatchObject({ activity: 'idle', openTools: [], tool: null });
    expect(s.avatars['visitor:Explore']).toMatchObject({ activity: 'idle', present: false });
    expect(s.avatars.architect?.activity).toBe('waiting');
  });

  it('BUG-11: idle since = lastEventAt + 120 s, whatever time the tick runs', () => {
    const a = tick(busy(), T + IDLE_AFTER_MS);
    const b = tick(busy(), T + 500_000);
    expect(a.avatars.coder?.since).toBe(T + IDLE_AFTER_MS);
    expect(b.avatars.coder?.since).toBe(T + IDLE_AFTER_MS);
    expect(b.avatars['visitor:Explore']).toEqual(a.avatars['visitor:Explore']);
  });

  it('a fresh state never times out', () => {
    const s = initialOfficeState();
    expect(tick(s, 10 ** 12)).toBe(s);
  });

  it('activity of other avatars keeps the session alive (JEBON stays delegating)', () => {
    let s = reduce(initialOfficeState(), ev('tool.start', { emittedAt: T, tool: { name: 'Agent', useId: 'ag', summary: '' } }));
    for (let i = 1; i <= 5; i++) s = reduce(s, ev('tool.start', { actor: CODER, emittedAt: T + i * 60_000 }));
    expect(tick(s, T + 5 * 60_000 + 1000).avatars.main?.activity).toBe('delegating');
  });
});

describe('tick: short-lived states', () => {
  it('an instant action reverts to working after INSTANT_MS', () => {
    const s = reduce(initialOfficeState(), ev('tool.end', { actor: CODER, emittedAt: T, tool: { name: 'Bash', summary: 'npm test' } }));
    expect(tick(s, T + INSTANT_MS - 1)).toBe(s);
    expect(tick(s, T + INSTANT_MS).avatars.coder).toMatchObject({ activity: 'working', instant: false, tool: null, since: T + INSTANT_MS });
  });

  it('a visitor whose error expires stays in the room (only quiet/session.end make it leave)', () => {
    const s = apply(
      initialOfficeState(),
      ev('agent.start', { actor: EXPLORE, emittedAt: T }),
      ev('tool.fail', { actor: EXPLORE, emittedAt: T + 1 }),
    );
    const after = tick(s, T + 1 + ERROR_MS).avatars['visitor:Explore'];
    expect(after).toMatchObject({ activity: 'idle', present: true, since: T + 1 + ERROR_MS });
  });

  it('waiting survives the 120 s rule but ends at the 300 s hook timeout', () => {
    const s = reduce(initialOfficeState(), ev('permission.request', { actor: CODER, emittedAt: T }));
    expect(tick(s, T + IDLE_AFTER_MS).avatars.coder?.activity).toBe('waiting');
    expect(tick(s, T + WAITING_MAX_MS - 1).avatars.coder?.activity).toBe('waiting');
    expect(tick(s, T + WAITING_MAX_MS).avatars.coder).toMatchObject({ activity: 'idle', since: T + WAITING_MAX_MS });
  });

  it('a waiting visitor that ages out during a quiet period leaves', () => {
    const s = apply(
      initialOfficeState(),
      ev('agent.start', { actor: EXPLORE, emittedAt: T }),
      ev('permission.request', { actor: EXPLORE, emittedAt: T }),
    );
    expect(tick(s, T + WAITING_MAX_MS).avatars['visitor:Explore']).toMatchObject({ activity: 'idle', present: false });
  });

  it('tick is idempotent: ticking the result again at the same time changes nothing', () => {
    const s = apply(
      initialOfficeState(),
      ev('agent.start', { actor: EXPLORE, emittedAt: T }),
      ev('tool.fail', { actor: CODER, emittedAt: T }),
      ev('tool.end', { actor: ARCH, emittedAt: T, tool: { name: 'Read', summary: '' } }),
    );
    for (const now of [T + ERROR_MS, T + IDLE_AFTER_MS, T + WAITING_MAX_MS]) {
      const once = tick(s, now);
      expect(tick(once, now)).toBe(once);
    }
  });
});

// A2.1: open work (an open tool or an open agent run) is exempt from the 120 s quiet rule, capped at 15 min.
describe('A2.1: busy avatars and the open-work cap', () => {
  const bash = { name: 'Bash', useId: 'long', summary: 'npm test' };
  const MIN = 60_000;

  it('AC1: an open tool survives 119.999 s and 10 min, then idles at exactly 15 min', () => {
    const s = reduce(initialOfficeState(), ev('tool.start', { actor: CODER, emittedAt: T, tool: bash }));
    expect(tick(s, T + IDLE_AFTER_MS - 1)).toBe(s);
    expect(tick(s, T + 10 * MIN).avatars.coder).toMatchObject({ activity: 'running', openTools: ['long'], tool: { name: 'Bash' } });
    expect(tick(s, T + OPEN_WORK_MAX_MS - 1)).toBe(s);
    expect(tick(s, T + OPEN_WORK_MAX_MS).avatars.coder).toMatchObject({
      activity: 'idle',
      since: T + OPEN_WORK_MAX_MS,
      openTools: [],
      agentOpen: false,
      tool: null,
    });
    expect(OPEN_WORK_MAX_MS).toBe(900_000);
  });

  it('AC2: after tool.end the normal 120 s rule applies again, at lastEventAt + 120 s', () => {
    const s = apply(
      initialOfficeState(),
      ev('tool.start', { actor: CODER, emittedAt: T, tool: bash }),
      ev('tool.end', { actor: CODER, emittedAt: T + 200_000, tool: bash }),
    );
    expect(s.avatars.coder).toMatchObject({ activity: 'working', openTools: [] });
    expect(tick(s, T + 200_000 + IDLE_AFTER_MS - 1)).toBe(s);
    expect(tick(s, T + 200_000 + IDLE_AFTER_MS).avatars.coder).toMatchObject({ activity: 'idle', since: T + 200_000 + IDLE_AFTER_MS });
    // Same result later (cadence independent).
    expect(tick(s, T + 900_000).avatars.coder?.since).toBe(T + 200_000 + IDLE_AFTER_MS);
  });

  it('AC3: an open agent run with no tools stays working for 10 min and idles at 15 min', () => {
    const s = reduce(initialOfficeState(), ev('agent.start', { actor: CODER, emittedAt: T }));
    expect(s.avatars.coder?.agentOpen).toBe(true);
    expect(tick(s, T + 10 * MIN).avatars.coder).toMatchObject({ activity: 'working', agentOpen: true });
    expect(tick(s, T + 15 * MIN).avatars.coder).toMatchObject({ activity: 'idle', agentOpen: false, since: T + 15 * MIN });
  });

  it('AC3: agent.stop at 10 min gives done, then the 120 s rule applies', () => {
    const s = apply(
      initialOfficeState(),
      ev('agent.start', { actor: CODER, emittedAt: T }),
      ev('agent.stop', { actor: CODER, emittedAt: T + 10 * MIN }),
    );
    expect(s.avatars.coder).toMatchObject({ activity: 'done', agentOpen: false });
    expect(tick(s, T + 10 * MIN + IDLE_AFTER_MS - 1)).toBe(s);
    expect(tick(s, T + 10 * MIN + IDLE_AFTER_MS).avatars.coder).toMatchObject({ activity: 'idle', since: T + 10 * MIN + IDLE_AFTER_MS });
  });

  it('AC4: main turn.stop while a desk agent is open: main idles at 120 s, the desk keeps working', () => {
    const s = apply(
      initialOfficeState(),
      ev('agent.start', { actor: CODER, emittedAt: T }),
      ev('turn.stop', { emittedAt: T + 1000 }),
    );
    const later = tick(s, T + 1000 + 5 * MIN);
    expect(later.avatars.main).toMatchObject({ activity: 'idle', since: T + 1000 + IDLE_AFTER_MS });
    expect(later.avatars.coder).toMatchObject({ activity: 'working', agentOpen: true });
  });

  it('AC5: session.end idles busy avatars at once; a visitor with an open tool leaves at the cap', () => {
    const s = apply(
      initialOfficeState(),
      ev('agent.start', { actor: CODER, emittedAt: T }),
      ev('tool.start', { actor: EXPLORE, emittedAt: T, tool: bash }),
      ev('session.end', { emittedAt: T + 1000 }),
    );
    expect(s.avatars.coder).toMatchObject({ activity: 'idle', agentOpen: false });
    expect(s.avatars['visitor:Explore']).toMatchObject({ activity: 'idle', present: false, openTools: [] });

    const v = reduce(initialOfficeState(), ev('tool.start', { actor: EXPLORE, emittedAt: T, tool: bash }));
    expect(tick(v, T + OPEN_WORK_MAX_MS - 1).avatars['visitor:Explore']).toMatchObject({ present: true, activity: 'running' });
    expect(tick(v, T + OPEN_WORK_MAX_MS).avatars['visitor:Explore']).toMatchObject({ present: false, activity: 'idle' });
  });

  it('AC6: tick is idempotent, returns the same object when nothing changes, and ignores cadence', () => {
    const s = apply(
      initialOfficeState(),
      ev('agent.start', { actor: CODER, emittedAt: T }),
      ev('tool.start', { actor: ARCH, emittedAt: T + 1000, tool: bash }),
      ev('tool.start', { actor: EXPLORE, emittedAt: T + 2000, tool: { ...bash, useId: 'v' } }),
    );
    for (const now of [T + 5 * MIN, T + OPEN_WORK_MAX_MS, T + 20 * MIN]) {
      const once = tick(s, now);
      expect(tick(once, now)).toBe(once);
    }
    expect(tick(s, T + 5 * MIN)).toBe(s);
    const fine = (() => {
      let cur = s;
      for (let t = T + 2000; t <= T + 20 * MIN; t += 1000) cur = tick(cur, t);
      return cur;
    })();
    const coarse = (() => {
      let cur = s;
      for (let t = T + 2000; t <= T + 20 * MIN; t += 60_000) cur = tick(cur, t);
      return tick(cur, T + 20 * MIN);
    })();
    expect(coarse).toEqual(fine);
    expect(fine.avatars.coder?.since).toBe(T + OPEN_WORK_MAX_MS);
    expect(fine.avatars.architect?.since).toBe(T + 1000 + OPEN_WORK_MAX_MS);
  });

  it('AC7: waiting is still capped at 300 s and ignores the 120 s rule; no-open-work avatars follow the quiet rule', () => {
    const s = apply(
      initialOfficeState(),
      ev('permission.request', { actor: ARCH, emittedAt: T }),
      ev('turn.stop', { actor: CODER, emittedAt: T }),
    );
    expect(tick(s, T + IDLE_AFTER_MS).avatars.architect?.activity).toBe('waiting');
    expect(tick(s, T + IDLE_AFTER_MS).avatars.coder?.activity).toBe('idle');
    expect(tick(s, T + WAITING_MAX_MS).avatars.architect).toMatchObject({ activity: 'idle', since: T + WAITING_MAX_MS });
  });

  it('agentOpen: set by agent.start only; cleared by agent.stop, turn.stop, session.end', () => {
    const open = reduce(initialOfficeState(), ev('agent.start', { actor: CODER, emittedAt: T }));
    expect(initialOfficeState().avatars.coder?.agentOpen).toBe(false);
    expect(reduce(initialOfficeState(), ev('tool.start', { actor: CODER, emittedAt: T })).avatars.coder?.agentOpen).toBe(false);
    for (const kind of ['agent.stop', 'turn.stop', 'session.end'] as const) {
      expect(reduce(open, ev(kind, { actor: CODER, emittedAt: T + 1 })).avatars.coder?.agentOpen).toBe(false);
    }
  });

  // AC8: on the observed sets, no avatar with an unmatched PreToolUse (or an open agent run)
  // goes idle before the cap. "waiting" and "error" have their own, shorter timers.
  it.each<FixtureSet>(['pc', 'pc2', 'pc-desktop'])('AC8: fixture replay %s keeps open work busy until the cap', async (set) => {
    const events = (await observedTimeline(set, T, 100)).filter((e) => e.kind !== 'session.end');
    let state = initialOfficeState();
    let checked = 0;
    for (const e of events) {
      state = reduce(state, e);
      for (const [key, a] of Object.entries(state.avatars)) {
        if ((a.openTools.length === 0 && !a.agentOpen) || a.activity === 'waiting' || a.activity === 'error') continue;
        const probe = tick(state, a.since + OPEN_WORK_MAX_MS - 1).avatars[key];
        expect(probe?.activity, `${set} ${key} after ${e.kind}`).not.toBe('idle');
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

// Uses fixtures/hooks/provisional: PROVISIONAL – from docs, not observed.
describe('fixture replay (provisional fixtures)', () => {
  it('the documented team run ends with JEBON done and the architect done', async () => {
    const events = await fixtureTimeline('provisional', T, 100);
    expect(events.length).toBeGreaterThan(10);
    const beforeEnd = events.filter((e) => e.kind !== 'session.end').reduce(reduce, initialOfficeState());
    expect(beforeEnd.avatars.architect?.agentId).toBe('agent-arch01');
    expect(beforeEnd.avatars.main?.activity).toBe('error'); // last fixture before SessionEnd is StopFailure
    expect(beforeEnd.avatars['visitor:Explore']).toMatchObject({ role: 'visitor', label: 'Explore' });
    const end = events.reduce(reduce, initialOfficeState());
    expect(Object.values(end.avatars).every((a) => a.activity === 'idle' && a.openTools.length === 0)).toBe(true);
  });
});

describe('purity', () => {
  it('reduce and tick never mutate their input', () => {
    const s = deepFreeze(initialOfficeState());
    const events = EVENT_KINDS.map((k, i) => deepFreeze(ev(k, { actor: i % 2 ? CODER : MAIN, emittedAt: T + i })));
    expect(() => {
      let cur: OfficeState = s;
      for (const e of events) cur = deepFreeze(reduce(cur, e));
      tick(cur, T + IDLE_AFTER_MS * 2);
    }).not.toThrow();
  });

  it('same events -> same state (deterministic)', () => {
    const events = EVENT_KINDS.map((k, i) => ev(k, { actor: CODER, emittedAt: T + i }));
    expect(events.reduce(reduce, initialOfficeState())).toEqual(events.reduce(reduce, initialOfficeState()));
  });
});
