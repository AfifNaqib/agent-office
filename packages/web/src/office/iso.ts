// Isometric math (plan §8 renderer: 2:1 diamond tiles, depth sort by x+y). Pure.

export const TILE_W = 64;
export const TILE_H = 32;

export interface Tile {
  readonly x: number;
  readonly y: number;
}

/** Tile (may be fractional while walking) -> screen offset of the tile's centre. */
export function toScreen(t: Tile): { sx: number; sy: number } {
  return { sx: ((t.x - t.y) * TILE_W) / 2, sy: ((t.x + t.y) * TILE_H) / 2 };
}

/** Screen offset -> tile coordinates (inverse of toScreen). */
export function toTile(sx: number, sy: number): Tile {
  return { x: sy / TILE_H + sx / TILE_W, y: sy / TILE_H - sx / TILE_W };
}

/** Painter's order: larger x+y is nearer the viewer and drawn later. `bias` breaks ties (avatars over furniture). */
export function depth(t: Tile, bias = 0): number {
  return (t.x + t.y) * 10 + bias;
}
