import { describe, expect, it } from 'vitest';
import type { LobbyEntry, OfficeEvent } from '@agent-office/core';
import { Follower } from '../src/follow.js';
import { ago, answerHint, focusHeir, lobbyRows, permissionLabel } from '../src/panel.js';

describe('permissionLabel (A1.1 table)', () => {
  it.each([
    [{ status: 'pending', actionable: true }, 'Waiting for you'],
    [{ status: 'pending', actionable: false }, 'Waiting in Claude'],
    [{ status: 'allow', actionable: false }, 'Allowed'],
    [{ status: 'deny', actionable: true }, 'Denied'],
    [{ status: 'expired', settledBy: 'decision', actionable: true }, 'Auto-denied: no decision in 4 min'],
    [{ status: 'expired', settledBy: 'run', actionable: true }, 'Run ended'],
    [{ status: 'expired', settledBy: 'session', actionable: true }, 'Run ended'],
    [{ status: 'expired', settledBy: 'activity', actionable: false }, 'Handled in Claude'],
    [{ status: 'expired', settledBy: 'turn', actionable: false }, 'Handled in Claude'],
    [{ status: 'expired', settledBy: 'session', actionable: false }, 'Handled in Claude'],
    [{ status: 'expired', settledBy: 'timeout', actionable: true }, 'No longer tracked. Check Claude'],
    [{ status: 'expired', settledBy: 'timeout', actionable: false }, 'No longer tracked. Check Claude'],
  ] as const)('%o -> %s', (card, label) => {
    expect(permissionLabel(card)).toBe(label);
  });
});

describe('answerHint (FR-016)', () => {
  it('cloud gets the deep link, local non-bridge gets the /rc hint', () => {
    expect(answerHint({ source: 'cloud', openUrl: 'https://claude.ai/code/session_x', controllable: false })).toEqual({ text: 'Open in Claude', url: 'https://claude.ai/code/session_x' });
    expect(answerHint({ source: 'local', openUrl: null, controllable: false }).text).toContain('/rc');
    expect(answerHint(undefined).text).toBe('Answer in Claude');
  });
});

it('ago', () => {
  expect([ago(5_000), ago(125_000), ago(7_300_000)]).toEqual(['5s', '2m', '2h']);
});

describe('Follower feed + pin', () => {
  const T0 = 5_000_000;
  let n = 0;
  const ev = (sessionId: string, at: number, over: Partial<OfficeEvent> = {}): OfficeEvent => ({
    v: 1,
    id: `p${++n}`,
    emittedAt: at,
    source: 'local',
    sessionId,
    actor: { kind: 'main', agentType: null, agentId: null },
    kind: 'prompt.submit',
    text: `hello ${sessionId}`,
    ...over,
  });

  it('the feed is the shown session only; pinning switches at once; null follows newest again', () => {
    const f = new Follower();
    f.push(ev('a', T0), T0);
    f.advance(T0 + 600);
    f.push(ev('b', T0 + 1_000), T0 + 1_000);
    f.advance(T0 + 1_600);
    expect(f.shownKey).toBe('local:a'); // b is newer, but a is not quiet yet
    expect(f.feed.items.map((i) => (i.type === 'line' ? i.text : ''))).toEqual(['hello a']);
    f.pin('local:b');
    expect(f.shownKey).toBe('local:b');
    expect(f.feed.items.map((i) => (i.type === 'line' ? i.text : ''))).toEqual(['hello b']);
    f.push(ev('a', T0 + 30_000), T0 + 30_000);
    f.advance(T0 + 30_600);
    expect(f.shownKey).toBe('local:b'); // pinned: a's newer activity does not steal it
    f.pin(null);
    f.advance(T0 + 30_700);
    expect(f.shownKey).toBe('local:a');
  });
});

describe('lobbyRows (W-01)', () => {
  const entry = { key: 'local:a', sessionId: 'a', repo: 'portfolio', source: 'local', status: 'working', lastEventAt: 10_000 } as unknown as LobbyEntry;

  it('keeps the key stable while the "ago" text moves, so the button can be updated in place', () => {
    const [r1] = lobbyRows([entry], 'local:a', 12_000);
    const [r2] = lobbyRows([entry], 'local:a', 17_000);
    expect(r1?.key).toBe(r2?.key);
    expect(r1?.meta).toBe('working · 2s');
    expect(r2?.meta).toBe('working · 7s');
    expect(r1).toMatchObject({ badge: 'PC', repo: 'portfolio', status: 'working', pressed: true });
  });

  it('falls back to the session id and marks only the shown session as pressed', () => {
    const cloud = { ...entry, key: 'cloud:b', sessionId: 'b', repo: undefined, source: 'cloud' } as unknown as LobbyEntry;
    const rows = lobbyRows([entry, cloud], 'cloud:b', 10_000);
    expect(rows.map((r) => [r.repo, r.badge, r.pressed])).toEqual([['portfolio', 'PC', false], ['b', 'Cloud', true]]);
  });
});

describe('focusHeir (B3)', () => {
  const order = ['a', 'b', 'c', 'd'];
  it('goes to the next kept session, else the previous one, else Follow newest (null)', () => {
    expect(focusHeir(order, 'b', new Set(['a', 'c', 'd']))).toBe('c');
    expect(focusHeir(order, 'd', new Set(['a', 'b', 'c']))).toBe('c');
    expect(focusHeir(order, 'b', new Set(['a', 'd']))).toBe('d');
    expect(focusHeir(order, 'c', new Set(['a']))).toBe('a');
    expect(focusHeir(order, 'a', new Set())).toBeNull();
    expect(focusHeir(['a'], 'a', new Set())).toBeNull();
  });
});
