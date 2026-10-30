// Screen-space layout for the office view. Pure, so it can be tested without a canvas.

export interface Fit {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

/** Scale and centre a content box (world px) inside a view (CSS px). */
export function fitRoom(view: { width: number; height: number }, box: { left: number; right: number; top: number; bottom: number }, margin: number): Fit {
  const w = box.right - box.left;
  const h = box.bottom - box.top;
  const scale = Math.max(0.01, Math.min(view.width / w, view.height / h) * margin);
  return { scale, x: view.width / 2 - ((box.left + box.right) / 2) * scale, y: view.height / 2 - ((box.top + box.bottom) / 2) * scale };
}

/** Highest renderer resolution used anywhere (3x costs 9x the pixels of 1x for little gain on a status board). */
export const MAX_RESOLUTION = 2;

/** Backing-store pixels above which a dense screen is rendered at a lower density. */
export const MAX_BACKING_PIXELS = 8_500_000;

/**
 * Renderer resolution for a device pixel ratio: the ratio itself (1.25, 1.5, 2.625 are kept),
 * never above MAX_RESOLUTION and never below 1. A canvas whose backing store would exceed
 * MAX_BACKING_PIXELS is scaled down continuously (sqrt of the pixel budget) instead of in
 * steps, so a 2560x1440 canvas at DPR 2 or 3 still gets about 1.5x.
 */
export function pickResolution(dpr: number, width: number, height: number): number {
  let r = Number.isFinite(dpr) ? Math.min(MAX_RESOLUTION, Math.max(1, dpr)) : 1;
  const area = Math.max(1, width * height);
  if (area * r * r > MAX_BACKING_PIXELS) r = Math.max(1, Math.sqrt(MAX_BACKING_PIXELS / area));
  return r;
}

export interface TagBox {
  readonly key: string;
  /** Screen position of the tag's bottom centre, before layout. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface TagPlace {
  readonly x: number;
  readonly y: number;
  /** The tag was moved off its avatar: draw a leader line back to (ax, ay). */
  readonly moved: boolean;
}

const GAP = 2;
const MAX_LIFT = 12;

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean =>
  Math.abs(a.x - b.x) * 2 < a.w + b.w + GAP && a.y - a.h < b.y + GAP && b.y - b.h < a.y + GAP;

/**
 * Name tags never overlap: front-most first (largest y keeps its place), each other tag is lifted by whole
 * tag heights until it is free, and kept inside the view (x and y: a tag is never above the
 * top or below the bottom edge). A tag that would leave the top is pushed down instead (lifting
 * stops at the top edge, then the search continues downwards), so a leader line always joins a
 * visible tag. Deterministic: ties go by key. After MAX_LIFT steps the last position is used.
 */
export function layoutTags(tags: readonly TagBox[], view: { width: number; height: number }): Map<string, TagPlace> {
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  const out = new Map<string, TagPlace>();
  const order = [...tags].sort((a, b) => b.y - a.y || a.x - b.x || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const t of order) {
    const x = Math.min(Math.max(t.x, t.w / 2), Math.max(t.w / 2, view.width - t.w / 2));
    const minY = t.h; // y is the tag's bottom edge, so the top edge is y - h
    const maxY = Math.max(minY, view.height);
    const clampY = (v: number): number => Math.min(maxY, Math.max(minY, v));
    const free = (v: number): boolean => !placed.some((p) => overlaps({ x, y: v, w: t.w, h: t.h }, p));
    let y = clampY(t.y);
    for (let i = 0; i < MAX_LIFT && !free(y); i++) {
      const up = y - (t.h + GAP);
      if (up >= minY) y = up;
      else break;
    }
    if (!free(y)) {
      // Top edge reached (or lift budget spent): look downwards from the anchor for a free slot.
      let down = clampY(t.y);
      for (let i = 0; i < MAX_LIFT && down + t.h + GAP <= maxY; i++) {
        down += t.h + GAP;
        if (free(down)) {
          y = down;
          break;
        }
      }
    }
    placed.push({ x, y, w: t.w, h: t.h });
    out.set(t.key, { x, y, moved: y !== t.y || x !== t.x });
  }
  return out;
}
