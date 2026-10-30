// Fixed room (FR-012) and where each avatar stands for its state. Pure.
import { toolActivity, type AvatarState } from '@agent-office/core';
import type { Tile } from './iso.js';

export const COLS = 12;
export const ROWS = 10;

export type FurnitureKind = 'lead-desk' | 'desk' | 'whiteboard' | 'server' | 'shelf' | 'coffee' | 'bench';

export interface Furniture {
  readonly kind: FurnitureKind;
  /** Tiles it covers; avatars cannot walk there. */
  readonly tiles: readonly Tile[];
}

const row = (x0: number, x1: number, y: number): Tile[] => Array.from({ length: x1 - x0 + 1 }, (_, i) => ({ x: x0 + i, y }));

export const FURNITURE: readonly Furniture[] = [
  { kind: 'whiteboard', tiles: row(5, 7, 0) },
  { kind: 'shelf', tiles: row(10, 11, 0) },
  { kind: 'server', tiles: [{ x: 0, y: 2 }, { x: 0, y: 3 }] },
  { kind: 'coffee', tiles: [{ x: 11, y: 3 }] },
  { kind: 'bench', tiles: [{ x: 11, y: 5 }, { x: 11, y: 6 }] },
  { kind: 'lead-desk', tiles: row(5, 6, 4) },
  { kind: 'desk', tiles: [{ x: 1, y: 7 }] },
  { kind: 'desk', tiles: [{ x: 3, y: 7 }] },
  { kind: 'desk', tiles: [{ x: 7, y: 7 }] },
  { kind: 'desk', tiles: [{ x: 9, y: 7 }] },
];

/** Where each desk owner sits (the tile in front of the desk). */
export const SEATS: Readonly<Record<string, Tile>> = {
  main: { x: 5, y: 5 },
  architect: { x: 1, y: 8 },
  coder: { x: 3, y: 8 },
  tester: { x: 7, y: 8 },
  manager: { x: 9, y: 8 },
};

export const SPOTS = {
  whiteboard: { x: 6, y: 1 },
  shelf: { x: 10, y: 1 },
  server: { x: 1, y: 2 },
  coffee: { x: 10, y: 3 },
  door: { x: 3, y: 0 },
} as const satisfies Record<string, Tile>;

/** Visitor seats: the four tiles by the bench first, then four standing spots next to them (8 visitors, one tile each). */
export const BENCH_SEATS: readonly Tile[] = [
  { x: 10, y: 5 },
  { x: 10, y: 6 },
  { x: 9, y: 5 },
  { x: 9, y: 6 },
  { x: 8, y: 5 },
  { x: 8, y: 6 },
  { x: 9, y: 4 },
  { x: 10, y: 4 },
];

/**
 * Seat for a new visitor. `used` lists the seat of every visitor already seated (a seat
 * appears once per visitor). The least-used seat wins, ties go to the lowest index, so
 * the first 8 visitors get distinct seats and visitor 9 onwards share them evenly
 * (visitor N shares with visitor N - 8). Deterministic.
 */
export function assignSeat(used: Iterable<number>): number {
  const counts = new Array<number>(BENCH_SEATS.length).fill(0);
  for (const i of used) if (i >= 0 && i < counts.length) counts[i] = (counts[i] ?? 0) + 1;
  let best = 0;
  for (let i = 1; i < counts.length; i++) if ((counts[i] ?? 0) < (counts[best] ?? 0)) best = i;
  return best;
}

/**
 * Two avatars never stand on the same tile (the server rack and the coffee corner
 * are shared stations). `wanted` is in priority order; one that finds its tile taken
 * gets the nearest free walkable tile (BFS, ties by scan order). The door is exempt:
 * everyone who is away waits there out of sight.
 */
export function spreadGoals(wanted: readonly { readonly key: string; readonly tile: Tile }[]): Map<string, Tile> {
  const out = new Map<string, Tile>();
  const used = new Set<string>();
  for (const { key: who, tile } of wanted) {
    let pick = tile;
    if (!(tile.x === SPOTS.door.x && tile.y === SPOTS.door.y) && used.has(key(tile))) {
      const seen = new Set([key(tile)]);
      const queue: Tile[] = [tile];
      pick = tile;
      search: for (let i = 0; i < queue.length; i++) {
        const cur = queue[i];
        if (!cur) break;
        for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
          const next = { x: cur.x + dx, y: cur.y + dy };
          if (seen.has(key(next)) || !walkable(next)) continue;
          seen.add(key(next));
          if (!used.has(key(next))) {
            pick = next;
            break search;
          }
          queue.push(next);
        }
      }
    }
    used.add(key(pick));
    out.set(who, pick);
  }
  return out;
}

const key = (t: Tile): string => `${t.x},${t.y}`;
const BLOCKED: ReadonlySet<string> = new Set(FURNITURE.flatMap((f) => f.tiles.map(key)));

export function walkable(t: Tile): boolean {
  return t.x >= 0 && t.y >= 0 && t.x < COLS && t.y < ROWS && !BLOCKED.has(key(t));
}

/** The tile an avatar should stand on for its current state. `visitorIndex` picks a bench seat. */
export function targetTile(a: AvatarState, visitorIndex = 0): Tile {
  if (!a.present) return SPOTS.door;
  if (a.role === 'visitor') return BENCH_SEATS[visitorIndex % BENCH_SEATS.length] ?? SPOTS.door;
  // Waiting for approval or failing: stay at the station of the tool involved (Bash -> server).
  const stay = a.activity === 'waiting' || a.activity === 'error' ? a.tool : null;
  switch (stay ? toolActivity(stay.name) : a.activity) {
    case 'delegating':
      return SPOTS.whiteboard;
    case 'running':
      return SPOTS.server;
    case 'browsing':
      return SPOTS.shelf;
    case 'done':
      return SPOTS.coffee;
    default:
      return SEATS[a.key] ?? SEATS.main ?? SPOTS.door;
  }
}

/**
 * Shortest walk on the tile grid (4-neighbour BFS), excluding `from`, ending at `to`.
 * [] when already there or unreachable. The grid is 120 tiles, so BFS per move is cheap.
 */
export function findPath(from: Tile, to: Tile): Tile[] {
  const start = { x: Math.round(from.x), y: Math.round(from.y) };
  if (start.x === to.x && start.y === to.y) return [];
  const prev = new Map<string, Tile | null>([[key(start), null]]);
  const queue: Tile[] = [start];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    if (!cur) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const next = { x: cur.x + dx, y: cur.y + dy };
      if (prev.has(key(next)) || !walkable(next)) continue;
      prev.set(key(next), cur);
      if (next.x === to.x && next.y === to.y) {
        const path: Tile[] = [];
        for (let t: Tile | null | undefined = next; t && key(t) !== key(start); t = prev.get(key(t))) path.unshift(t);
        return path;
      }
      queue.push(next);
    }
  }
  return [];
}
