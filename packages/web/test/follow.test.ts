import { describe, expect, it } from 'vitest';
import { REORDER_WINDOW_MS, type OfficeEvent } from '@agent-office/core';
import { FOLLOW_QUIET_MS, Follower } from '../src/follow.js';

const T0 = 1_000_000;
let n = 0;
const ev = (sessionId: string, at: number, over: Partial<OfficeEvent> = {}): OfficeEvent => ({
  v: 1,
  id: `e${++n}`,
  emittedAt: at,
  source: 'local',
  sessionId,
  repo: `repo-${sessionId}`,
  actor: { kind: 'main', agentType: null, agentId: null },
  kind: 'tool.start',
  tool: { name: 'Read', useId: `u${n}`, summary: '' },
  ...over,
});

describe('Follower', () => {
  it('applies events after the reorder window, in emittedAt order', () => {
    const f = new Follower();
    f.push(ev('a', T0 + 10, { tool: { name: 'Bash', useId: 'b', summary: '' } }), T0);
    f.push(ev('a', T0 + 5, { kind: 'session.start', tool: undefined }), T0); // arrives out of order
    expect(f.advance(T0 + 100).avatars.main?.activity).toBe('idle'); // still buffered
    const s = f.advance(T0 + REORDER_WINDOW_MS + 1);
    expect(s.avatars.main?.activity).toBe('running');
    expect(f.current(T0 + REORDER_WINDOW_MS + 1)?.repo).toBe('repo-a');
  });

  it('follows the newest session only after the shown one is quiet for FOLLOW_QUIET_MS', () => {
    const f = new Follower();
    f.push(ev('a', T0), T0);
    f.advance(T0 + 600);
    expect(f.shownKey).toBe('local:a');
    f.push(ev('b', T0 + 5_000), T0 + 5_000);
    f.advance(T0 + 5_600);
    expect(f.shownKey).toBe('local:a'); // a was busy 5 s ago: stay
    f.push(ev('b', T0 + FOLLOW_QUIET_MS + 1), T0 + FOLLOW_QUIET_MS + 1);
    const s = f.advance(T0 + FOLLOW_QUIET_MS + 600);
    expect(f.shownKey).toBe('local:b');
    expect(s.avatars.main?.activity).toBe('reading'); // rebuilt from b's history
  });

  it('reset forgets everything (bridge restart)', () => {
    const f = new Follower();
    f.push(ev('a', T0), T0);
    f.advance(T0 + 600);
    f.reset();
    expect(f.shownKey).toBeNull();
    expect(f.advance(T0 + 700).avatars.main?.activity).toBe('idle');
  });
});
