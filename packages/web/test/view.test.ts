import { describe, expect, it } from 'vitest';
import { BENCH_SEATS, SPOTS, assignSeat, spreadGoals, walkable } from '../src/office/layout.js';
import { MAX_BACKING_PIXELS, fitRoom, layoutTags, pickResolution, type TagBox } from '../src/office/view.js';

describe('visitor seats (UI-L8 b)', () => {
  it('has 8 distinct walkable seats', () => {
    expect(new Set(BENCH_SEATS.map((t) => `${t.x},${t.y}`)).size).toBe(8);
    for (const t of BENCH_SEATS) expect(walkable(t)).toBe(true);
  });
  it('gives the lowest free seat, reuses freed ones, wraps deterministically past 8', () => {
    expect(assignSeat([])).toBe(0);
    expect(assignSeat([0, 1, 3])).toBe(2);
    expect(assignSeat([0, 1, 2, 3, 4, 5, 6, 7])).toBe(0);
  });
  it('B1: 20 visitors share the 8 seats evenly (no seat pile-up), deterministically', () => {
    const used: number[] = [];
    for (let n = 0; n < 20; n++) used.push(assignSeat(used));
    expect(used.slice(0, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(used.slice(8, 16)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(used.slice(16)).toEqual([0, 1, 2, 3]);
    const per = BENCH_SEATS.map((_, i) => used.filter((u) => u === i).length);
    expect(Math.max(...per) - Math.min(...per)).toBeLessThanOrEqual(1);
  });
  it('B1: a freed seat is reused before sharing', () => {
    const used = [0, 1, 2, 3, 4, 5, 6, 7, 0, 1];
    used.splice(used.indexOf(5), 1);
    expect(assignSeat(used)).toBe(5);
  });
});

describe('spreadGoals', () => {
  it('moves a second avatar off an occupied station to the nearest free walkable tile', () => {
    const g = spreadGoals([
      { key: 'a', tile: SPOTS.server },
      { key: 'b', tile: SPOTS.server },
      { key: 'c', tile: SPOTS.server },
    ]);
    const tiles = [...g.values()].map((t) => `${t.x},${t.y}`);
    expect(new Set(tiles).size).toBe(3);
    expect(g.get('a')).toEqual(SPOTS.server);
    for (const t of g.values()) {
      expect(walkable(t)).toBe(true);
      expect(Math.abs(t.x - SPOTS.server.x) + Math.abs(t.y - SPOTS.server.y)).toBeLessThanOrEqual(2);
    }
  });
  it('leaves the door shared', () => {
    const g = spreadGoals([{ key: 'a', tile: SPOTS.door }, { key: 'b', tile: SPOTS.door }]);
    expect(g.get('b')).toEqual(SPOTS.door);
  });
});

describe('layoutTags (UI-L8 a)', () => {
  const VIEW = { width: 400, height: 400 };
  const box = (key: string, x: number, y: number): TagBox => ({ key, x, y, w: 60, h: 14 });
  const overlap = (a: { x: number; y: number }, b: { x: number; y: number }): boolean => Math.abs(a.x - b.x) * 2 < 60 && a.y - 14 < b.y && b.y - 14 < a.y;

  it('stacks tags that start on the same spot (server rack) and keeps the front one in place', () => {
    const tags = Array.from({ length: 8 }, (_, i) => box(`t${i}`, 100, 200));
    const out = layoutTags(tags, VIEW);
    const places = [...out.values()];
    for (const [i, a] of places.entries()) for (const b of places.slice(i + 1)) expect(overlap(a, b)).toBe(false);
    expect(places.filter((p) => !p.moved)).toHaveLength(1);
  });
  it('is deterministic and independent of input order', () => {
    const tags = [box('b', 100, 200), box('a', 110, 200), box('c', 90, 190)];
    const x = layoutTags(tags, VIEW);
    const y = layoutTags([...tags].reverse(), VIEW);
    for (const k of ['a', 'b', 'c']) expect(x.get(k)).toEqual(y.get(k));
  });
  it('keeps tags inside the view', () => {
    const out = layoutTags([box('l', 5, 100), box('r', 395, 100)], VIEW);
    expect(out.get('l')?.x).toBe(30);
    expect(out.get('r')?.x).toBe(370);
  });
});

describe('layoutTags B2: y stays inside the view', () => {
  const view = { width: 390, height: 300 };
  const tag = (key: string, x: number, y: number): TagBox => ({ key, x, y, w: 60, h: 14 });
  const inside = (p: { x: number; y: number }): boolean => p.y - 14 >= 0 && p.y <= view.height && p.x - 30 >= 0 && p.x + 30 <= view.width;
  it('a tag anchored at or above the top edge is pushed down, not off screen', () => {
    for (const y of [-40, -2, 0, 5, 14]) expect(inside(layoutTags([tag('a', 100, y)], view).get('a') as { x: number; y: number })).toBe(true);
  });
  it('a tag anchored below the bottom edge is lifted into the view', () => {
    expect(inside(layoutTags([tag('a', 100, 900)], view).get('a') as { x: number; y: number })).toBe(true);
  });
  it('a crowd at the top edge stays inside, without overlaps', () => {
    const tags = Array.from({ length: 13 }, (_, i) => tag(`t${i}`, 100 + (i % 3) * 5, 4));
    const places = [...layoutTags(tags, view).values()];
    for (const p of places) expect(inside(p)).toBe(true);
    for (const [i, a] of places.entries()) for (const b of places.slice(i + 1)) expect(Math.abs(a.x - b.x) * 2 < 60 && a.y - 14 < b.y && b.y - 14 < a.y).toBe(false);
  });
  it('a crowd at the bottom edge stays inside too', () => {
    const tags = Array.from({ length: 13 }, (_, i) => tag(`t${i}`, 100, 299 + i));
    for (const p of layoutTags(tags, view).values()) expect(inside(p)).toBe(true);
  });
  it('a tag already inside the view and free keeps its place (not moved)', () => {
    expect(layoutTags([tag('a', 100, 150)], view).get('a')).toEqual({ x: 100, y: 150, moved: false });
  });
});

describe('fitRoom and pickResolution (UI-L8 c, d)', () => {
  const room = { left: -352, right: 352, top: -132, bottom: 352 };
  it.each([[1440, 900], [1059, 900], [390, 340], [320, 280], [2560, 1300]])('room fits a %ix%i view', (width, height) => {
    const f = fitRoom({ width, height }, room, 0.94);
    expect(room.left * f.scale + f.x).toBeGreaterThanOrEqual(0);
    expect(room.right * f.scale + f.x).toBeLessThanOrEqual(width);
    expect(room.top * f.scale + f.y).toBeGreaterThanOrEqual(0);
    expect(room.bottom * f.scale + f.y).toBeLessThanOrEqual(height);
  });
  const PHONE = [390, 844] as const;
  const DESK = [1440, 900] as const;
  const BIG = [2560, 1440] as const;
  it.each([1, 1.25, 1.5, 2, 3])('DPR %s: never above 2, never below 1, never above the pixel budget', (dpr) => {
    for (const [w, h] of [PHONE, DESK, BIG]) {
      const r = pickResolution(dpr, w, h);
      expect(r).toBeLessThanOrEqual(2);
      expect(r).toBeGreaterThanOrEqual(1);
      expect(r).toBeLessThanOrEqual(dpr);
      expect(w * h * r * r).toBeLessThanOrEqual(MAX_BACKING_PIXELS + 1);
    }
  });
  it('phone and laptop sizes get the device ratio (capped at 2)', () => {
    expect([1, 1.25, 1.5, 2, 3].map((d) => pickResolution(d, ...PHONE))).toEqual([1, 1.25, 1.5, 2, 2]);
    expect([1, 1.25, 1.5, 2, 3].map((d) => pickResolution(d, ...DESK))).toEqual([1, 1.25, 1.5, 2, 2]);
  });
  it('2560x1440 canvas: DPR 1, 1.25, 1.5 kept; DPR 2 and 3 get at least 1.5x (B4)', () => {
    expect([1, 1.25, 1.5].map((d) => pickResolution(d, ...BIG))).toEqual([1, 1.25, 1.5]);
    for (const d of [2, 3]) expect(pickResolution(d, ...BIG)).toBeGreaterThanOrEqual(1.5);
  });
  it('scales down continuously, not in steps, and never below 1', () => {
    const rs = [2560, 2800, 3000, 3400, 4000].map((w) => pickResolution(2, w, 1440));
    for (let i = 1; i < rs.length; i++) expect(rs[i]).toBeLessThan(rs[i - 1] as number);
    expect(pickResolution(2, 8000, 4000)).toBe(1);
  });
  it('junk -> 1', () => {
    expect(pickResolution(0.5, 400, 400)).toBe(1);
    expect(pickResolution(Number.NaN, 400, 400)).toBe(1);
    expect(pickResolution(Number.POSITIVE_INFINITY, 400, 400)).toBe(1);
  });
});
