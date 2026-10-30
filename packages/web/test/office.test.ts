import { describe, expect, it } from 'vitest';
import { initialOfficeState, reduce, type AvatarState } from '@agent-office/core';
import { depth, toScreen, toTile } from '../src/office/iso.js';
import { BENCH_SEATS, COLS, FURNITURE, ROWS, SEATS, SPOTS, findPath, targetTile, walkable } from '../src/office/layout.js';
import { demoEvents } from '../src/demo.js';

describe('iso math', () => {
  it('toTile inverts toScreen', () => {
    for (const t of [{ x: 0, y: 0 }, { x: 3, y: 7 }, { x: 11.5, y: 2.25 }]) {
      const { sx, sy } = toScreen(t);
      const back = toTile(sx, sy);
      expect(back.x).toBeCloseTo(t.x);
      expect(back.y).toBeCloseTo(t.y);
    }
  });

  it('tile (1,0) is down-right of (0,0), (0,1) down-left', () => {
    expect(toScreen({ x: 1, y: 0 })).toEqual({ sx: 32, sy: 16 });
    expect(toScreen({ x: 0, y: 1 })).toEqual({ sx: -32, sy: 16 });
  });

  it('nearer tiles (larger x+y) draw later; bias breaks ties', () => {
    expect(depth({ x: 2, y: 3 })).toBeGreaterThan(depth({ x: 2, y: 2 }));
    expect(depth({ x: 1, y: 1 }, 5)).toBeGreaterThan(depth({ x: 1, y: 1 }));
    expect(depth({ x: 1, y: 1 }, 5)).toBeLessThan(depth({ x: 2, y: 1 }));
  });
});

describe('room layout', () => {
  const spots = [...Object.values(SEATS), ...Object.values(SPOTS), ...BENCH_SEATS];

  it('every seat and spot is walkable and reachable from the door', () => {
    for (const s of spots) {
      expect(walkable(s)).toBe(true);
      if (s !== SPOTS.door) expect(findPath(SPOTS.door, s).length).toBeGreaterThan(0);
    }
  });

  it('paths never cross furniture and move one tile at a time', () => {
    const path = findPath(SEATS.architect ?? SPOTS.door, SPOTS.shelf);
    let prev = SEATS.architect ?? SPOTS.door;
    for (const t of path) {
      expect(walkable(t)).toBe(true);
      expect(Math.abs(t.x - prev.x) + Math.abs(t.y - prev.y)).toBe(1);
      prev = t;
    }
    expect(prev).toEqual(SPOTS.shelf);
  });

  it('furniture stays inside the room', () => {
    for (const t of FURNITURE.flatMap((f) => f.tiles)) {
      expect(t.x).toBeLessThan(COLS);
      expect(t.y).toBeLessThan(ROWS);
    }
  });

  it('maps states to stations; waiting and error stay at their tool station', () => {
    const base = initialOfficeState().avatars.coder as AvatarState;
    const at = (p: Partial<AvatarState>) => targetTile({ ...base, ...p });
    expect(at({ activity: 'typing' })).toEqual(SEATS.coder);
    expect(at({ activity: 'running' })).toEqual(SPOTS.server);
    expect(at({ activity: 'waiting', tool: { name: 'Bash', summary: '' } })).toEqual(SPOTS.server);
    expect(at({ activity: 'error', tool: { name: 'WebFetch', summary: '' } })).toEqual(SPOTS.shelf);
    expect(at({ activity: 'delegating' })).toEqual(SPOTS.whiteboard);
    expect(at({ present: false })).toEqual(SPOTS.door);
    expect(targetTile({ ...base, role: 'visitor' }, 1)).toEqual(BENCH_SEATS[1]);
  });
});

describe('demo run', () => {
  it('drives every desk agent plus a visitor and ends with JEBON done', () => {
    const seen = new Map<string, Set<string>>();
    let s = initialOfficeState();
    for (const e of demoEvents()) {
      s = reduce(s, e);
      for (const a of Object.values(s.avatars)) {
        const set = seen.get(a.key) ?? new Set<string>();
        set.add(a.activity);
        seen.set(a.key, set);
      }
    }
    expect(s.avatars.main?.activity).toBe('done');
    for (const k of ['architect', 'coder', 'tester', 'manager', 'visitor:Explore']) expect(seen.get(k)?.has('done')).toBe(true);
    expect(seen.get('coder')?.has('waiting')).toBe(true);
    expect(seen.get('tester')?.has('error')).toBe(true);
    expect(seen.get('main')?.has('delegating')).toBe(true);
  });
});
