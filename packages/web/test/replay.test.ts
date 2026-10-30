// V0-05 AC: the observed team run (fixtures/sessions/team-run.jsonl) replayed through
// the Follower gives the expected avatar / feed / lobby sequence. This is the same
// state the page exposes as window.__office.state().
import { describe, expect, it } from 'vitest';
import type { FeedPermission } from '@agent-office/core';
import { Follower } from '../src/follow.js';
import { permissionLabel } from '../src/panel.js';
import { readTeamRun, TEAM_RUN_T0 } from './helpers/team-run.js';

/** Replay every event up to `sec` seconds into the run, then look at the room `settleMs` later. */
function replayTo(sec: number, settleMs = 700) {
  const f = new Follower();
  const limit = TEAM_RUN_T0 + sec * 1000;
  for (const e of readTeamRun().filter((x) => x.emittedAt <= limit)) {
    f.push(e, e.emittedAt);
    f.advance(e.emittedAt + 700);
  }
  const now = limit + settleMs;
  const state = f.advance(now);
  const act = (key: string): string => {
    const a = state.avatars[key];
    return a ? (a.present ? a.activity : 'gone') : 'absent';
  };
  const cards = f.feed.items.filter((i): i is FeedPermission => i.type === 'permission');
  return { f, state, act, cards, lobby: f.lobby(now) };
}

describe('team-run replay', () => {
  it('main takes the prompt, delegates, then the architect reads', () => {
    expect(replayTo(1).act('main')).toBe('working');
    expect(replayTo(2).act('main')).toBe('delegating');
    expect(replayTo(5).act('architect')).toBe('working');
    expect(replayTo(7).act('architect')).toBe('reading');
    expect(replayTo(8).act('architect')).toBe('working');
  });

  it('the tester runs a long Bash call (12 s) that stays "running" until it ends', () => {
    expect(replayTo(13.3).act('tester')).toBe('working');
    expect(replayTo(15.3).act('tester')).toBe('running');
    expect(replayTo(26.5, 0).act('tester')).toBe('running'); // still open 11 s later
    expect(replayTo(27.5).act('tester')).toBe('working');
    expect(replayTo(30.5).act('tester')).toBe('done');
  });

  it('JEBON browses while the subagents work, and the architect finishes first', () => {
    const t = replayTo(12.3);
    expect(t.act('main')).toBe('browsing');
    expect(replayTo(18.3).act('architect')).toBe('done');
    expect(replayTo(21.3).act('main')).toBe('done');
  });

  it('the permission card is pending (and the avatar waits) until the tool fails, then it is settled', () => {
    const waiting = replayTo(34.5);
    expect(waiting.act('main')).toBe('waiting');
    expect(waiting.cards).toHaveLength(1);
    expect(waiting.cards[0]).toMatchObject({ status: 'pending', toolName: 'Bash' });
    expect(permissionLabel(waiting.cards[0] as FeedPermission)).toMatch(/^Waiting/);
    expect(waiting.lobby).toHaveLength(1);
    expect(waiting.lobby[0]?.status).toBe('live');

    const after = replayTo(43.5);
    expect(after.act('main')).toBe('error');
    expect(after.cards).toHaveLength(1);
    expect(after.cards[0]?.status).toBe('expired');
    expect(permissionLabel(after.cards[0] as FeedPermission)).toBe('Handled in Claude');
  });

  it('the feed reads in order, and the session ends everyone', () => {
    const end = replayTo(46);
    const lines = end.f.feed.items.map((i) => (i.type === 'permission' ? `perm:${i.toolName}` : i.text));
    expect(lines[0]).toBe('session started');
    expect(lines.at(-1)).toBe('session ended');
    expect(lines).not.toContain('done: done'); // UI-L8: no duplicate prefix
    expect(lines).toContain('done');
    const perm = lines.indexOf('perm:Bash');
    expect(perm).toBeGreaterThan(0);
    expect(lines.findIndex((l) => l.includes('Exit code 3'))).toBeGreaterThan(perm);
    for (const k of ['main', 'architect', 'tester']) expect(end.act(k)).toBe('idle');
    expect(end.lobby[0]?.status).toBe('ended');
    expect(end.f.shownKey).toBe(end.lobby[0]?.key);
  });
});
