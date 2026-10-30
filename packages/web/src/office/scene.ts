// PixiJS office scene (V0-04): "Nothing-style night office". Everything is drawn
// with Graphics, so there are no third-party assets (see ASSETS-LICENSES.md).
import { Container, Graphics, Text, type Application } from 'pixi.js';
import type { AvatarState, OfficeState } from '@agent-office/core';
import { TILE_H, TILE_W, depth, toScreen, type Tile } from './iso.js';
import { COLS, FURNITURE, ROWS, SEATS, SPOTS, assignSeat, findPath, spreadGoals, targetTile, type Furniture } from './layout.js';
import { fitRoom, layoutTags, type TagBox } from './view.js';

const C = {
  bg: 0x0a0a0b,
  floor: 0x141416,
  floorLine: 0x222226,
  wall: 0x101012,
  edge: 0xe6e6e6,
  top: 0x1e1e21,
  left: 0x141417,
  right: 0x0e0e10,
  white: 0xf2f2f2,
  dim: 0x6b6b70,
  red: 0xff2d2d,
} as const;

/** Agent colours are used on name tags only (art direction). */
const TAG: Readonly<Record<string, number>> = {
  main: 0xffffff,
  architect: 0x7fb2ff,
  coder: 0x7dff9a,
  tester: 0xffd166,
  manager: 0xc792ea,
};
const VISITOR_TAG = 0x9e9e9e;
const WALL_H = 112;
const WALK_TILES_PER_S = 3;
/** Name tags are drawn in screen space at a fixed readable size, however small the room is scaled. */
const TAG_FONT = 10;
const TAG_PAD = 3;
/** Narrow screens: the room fills more of the pane. */
const NARROW_PX = 600;

// ---- drawing helpers ----

/** Iso box on one tile: top diamond + two side faces, `h` px tall, shrunk by `inset` (0..0.5). */
function box(g: Graphics, t: Tile, h: number, inset = 0.1, fill: { top: number; left: number; right: number } = C): void {
  const { sx, sy } = toScreen(t);
  const w = (TILE_W / 2) * (1 - inset * 2);
  const d = (TILE_H / 2) * (1 - inset * 2);
  const edge = { width: 1, color: C.edge, alpha: 0.35 };
  g.poly([sx - w, sy - h, sx, sy + d - h, sx, sy + d, sx - w, sy]).fill(fill.left).stroke(edge);
  g.poly([sx, sy + d - h, sx + w, sy - h, sx + w, sy, sx, sy + d]).fill(fill.right).stroke(edge);
  g.poly([sx, sy - d - h, sx + w, sy - h, sx, sy + d - h, sx - w, sy - h]).fill(fill.top).stroke(edge);
}

// 3x5 dot-matrix glyphs for the wall sign.
const GLYPHS: Readonly<Record<string, string>> = {
  A: '010101111101101', G: '011100101101011', E: '111100110100111', N: '101111111101101',
  T: '111010010010010', O: '010101101101010', F: '111100110100100', I: '111010010010111',
  C: '011100100100011', ' ': '000000000000000',
};

/** Dot-matrix text painted onto the back (x-axis) wall, starting at tile column `x0`. */
function dotSign(g: Graphics, text: string, x0: number, top: number): void {
  const step = 6;
  let col = 0;
  for (const ch of text) {
    const bits = GLYPHS[ch] ?? GLYPHS[' '] ?? '';
    for (let i = 0; i < 15; i++) {
      const u = col + (i % 3);
      const v = Math.floor(i / 3);
      // Wall runs along +x: one dot step right moves (step, step/2) on screen.
      const { sx, sy } = toScreen({ x: x0, y: -0.5 });
      const px = sx + u * step;
      const py = sy - top + u * (step / 2) + v * step;
      if (bits[i] === '1') g.circle(px, py, 2.2).fill(C.red);
      else g.circle(px, py, 1).fill({ color: C.floorLine, alpha: 0.8 });
    }
    col += 4;
  }
}

function drawRoom(g: Graphics): void {
  for (let x = 0; x < COLS; x++) {
    for (let y = 0; y < ROWS; y++) {
      const { sx, sy } = toScreen({ x, y });
      g.poly([sx, sy - TILE_H / 2, sx + TILE_W / 2, sy, sx, sy + TILE_H / 2, sx - TILE_W / 2, sy])
        .fill(C.floor)
        .stroke({ width: 1, color: C.floorLine });
    }
  }
  // Back walls along the y = -0.5 and x = -0.5 edges.
  const a = toScreen({ x: -0.5, y: -0.5 });
  const b = toScreen({ x: COLS - 0.5, y: -0.5 });
  const c = toScreen({ x: -0.5, y: ROWS - 0.5 });
  const edge = { width: 1, color: C.edge, alpha: 0.5 };
  g.poly([a.sx, a.sy, b.sx, b.sy, b.sx, b.sy - WALL_H, a.sx, a.sy - WALL_H]).fill(C.wall).stroke(edge);
  g.poly([a.sx, a.sy, c.sx, c.sy, c.sx, c.sy - WALL_H, a.sx, a.sy - WALL_H]).fill(0x0c0c0e).stroke(edge);
  dotSign(g, 'AGENT OFFICE', 0.3, 108);
  // Door: a dark opening in the back wall behind SPOTS.door.
  const d0 = toScreen({ x: SPOTS.door.x - 0.4, y: -0.5 });
  const d1 = toScreen({ x: SPOTS.door.x + 0.4, y: -0.5 });
  g.poly([d0.sx, d0.sy, d1.sx, d1.sy, d1.sx, d1.sy - 56, d0.sx, d0.sy - 56]).fill(0x000000).stroke({ width: 1, color: C.edge, alpha: 0.6 });
}

/** One Graphics per furniture tile, so each tile depth-sorts with avatars. */
function drawFurniture(f: Furniture, t: Tile, i: number): Graphics {
  const g = new Graphics();
  const { sx, sy } = toScreen(t);
  switch (f.kind) {
    case 'desk':
    case 'lead-desk': {
      box(g, t, 18, 0.08);
      // Monitor: dark frame, white glow screen.
      g.rect(sx - 9, sy - 40, 18, 13).fill(0x050505).stroke({ width: 1, color: C.edge, alpha: 0.6 });
      g.rect(sx - 7, sy - 38, 14, 9).fill({ color: C.white, alpha: 0.18 });
      g.rect(sx - 1, sy - 27, 2, 6).fill(C.dim);
      break;
    }
    case 'whiteboard':
      box(g, t, 6, 0.35);
      g.poly([sx - 30, sy - 28, sx + 2, sy - 12, sx + 2, sy - 52, sx - 30, sy - 68]).fill(0xdedede).stroke({ width: 1, color: C.dim });
      if (i === 1) g.poly([sx - 22, sy - 50, sx - 8, sy - 43]).stroke({ width: 1, color: C.red });
      break;
    case 'server':
      box(g, t, 60, 0.12);
      break;
    case 'shelf':
      box(g, t, 52, 0.12);
      for (let r = 0; r < 3; r++) g.rect(sx - 20, sy - 44 + r * 14, 18, 2).fill(C.dim);
      break;
    case 'coffee':
      box(g, t, 22, 0.15);
      g.rect(sx - 3, sy - 30, 6, 6).fill(C.white);
      break;
    case 'bench':
      box(g, t, 9, 0.12);
      break;
  }
  g.zIndex = depth(t, 0);
  return g;
}

// ---- avatars ----

class AvatarSprite {
  readonly root = new Container();
  private readonly body = new Graphics();
  private readonly fx = new Graphics();
  /** Name tag: lives in the scene's tag layer (screen space, fixed size), not in the room. */
  readonly tagBox = new Container();
  private readonly tagBg = new Graphics();
  private readonly tag: Text;
  /** Where the tag wants to sit, in room coordinates (above the head). Set by draw(). */
  tagAnchor = { x: 0, y: 0 };
  /** Tag size in px at scale 1. */
  readonly tagW: number;
  readonly tagH: number;
  pos: Tile;
  private path: Tile[] = [];
  private goal: Tile;
  private walking = false;

  constructor(readonly key: string, label: string, start: Tile, color: number, resolution: number) {
    this.pos = start;
    this.goal = start;
    this.tag = new Text({ text: label, style: { fontFamily: 'monospace', fontSize: TAG_FONT, fill: color, letterSpacing: 1 }, resolution });
    this.tag.anchor.set(0.5, 1);
    this.tagW = Math.ceil(this.tag.width) + TAG_PAD * 2;
    this.tagH = Math.ceil(this.tag.height) + TAG_PAD;
    // A dark plate keeps the tag readable over furniture and other avatars.
    this.tagBg.rect(-this.tagW / 2, -this.tagH, this.tagW, this.tagH).fill({ color: C.bg, alpha: 0.78 });
    this.tag.position.set(0, -TAG_PAD / 2);
    this.tagBox.addChild(this.tagBg, this.tag);
    this.root.addChild(this.body, this.fx);
  }

  setGoal(goal: Tile, reducedMotion: boolean): void {
    if (goal.x === this.goal.x && goal.y === this.goal.y) return;
    this.goal = goal;
    if (reducedMotion) {
      this.pos = goal;
      this.path = [];
    } else {
      this.path = findPath(this.pos, goal);
    }
  }

  /** Move along the path. */
  step(dtMs: number): void {
    let budget = (WALK_TILES_PER_S * dtMs) / 1000;
    while (budget > 0 && this.path.length > 0) {
      const next = this.path[0];
      if (!next) break;
      const dx = next.x - this.pos.x;
      const dy = next.y - this.pos.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= budget) {
        this.pos = next;
        this.path.shift();
        budget -= dist;
      } else {
        this.pos = { x: this.pos.x + (dx / dist) * budget, y: this.pos.y + (dy / dist) * budget };
        budget = 0;
      }
    }
    this.walking = this.path.length > 0;
  }

  get isWalking(): boolean {
    return this.walking;
  }

  get atDoor(): boolean {
    return this.path.length === 0 && this.pos.x === SPOTS.door.x && this.pos.y === SPOTS.door.y;
  }

  /** Redraw the pose for the state (each activity has its own pose or effect). */
  draw(a: AvatarState, t: number, reducedMotion: boolean): void {
    const { sx, sy } = toScreen(this.pos);
    this.root.position.set(sx, sy);
    this.root.zIndex = depth(this.pos, 5);
    const lead = a.role === 'lead';
    const s = lead ? 1.15 : 1;
    const act = this.walking ? 'walk' : a.activity;
    const anim = !reducedMotion;
    const bob = anim && (act === 'idle' || act === 'done') ? Math.round(Math.sin(t / 500) * 1) : 0;
    const shake = anim && act === 'error' ? Math.round(Math.sin(t / 30) * 2) : 0;
    const leg = anim && act === 'walk' ? Math.round(Math.sin(t / 90) * 3) : 0;
    const x0 = shake;
    const y0 = bob;
    const b = this.body.clear();
    const fx = this.fx.clear();

    b.ellipse(0, 0, 9, 4).fill({ color: 0x000000, alpha: 0.6 });
    // Legs.
    b.rect(x0 - 4, y0 - 10 + Math.min(0, leg), 3, 10 - Math.abs(Math.min(0, leg))).fill(C.white);
    b.rect(x0 + 1, y0 - 10 + Math.min(0, -leg), 3, 10 - Math.abs(Math.min(0, -leg))).fill(C.white);
    // Torso + head (white figure, dark outline).
    const tw = 12 * s;
    const th = 13 * s;
    b.rect(x0 - tw / 2, y0 - 10 - th, tw, th).fill(C.white).stroke({ width: 1, color: 0x000000 });
    b.rect(x0 - 5, y0 - 10 - th - 10, 10, 10).fill(C.white).stroke({ width: 1, color: 0x000000 });
    b.rect(x0 - 3, y0 - 10 - th - 6, 2, 2).fill(0x000000);
    b.rect(x0 + 1, y0 - 10 - th - 6, 2, 2).fill(0x000000);
    if (lead) b.circle(x0 + tw / 2 - 2, y0 - 10 - th + 3, 1.5).fill(C.red);
    const headTop = y0 - 10 - th - 10;
    const armY = y0 - 10 - th + 3;

    switch (act) {
      case 'typing': {
        const tap = anim && Math.floor(t / 120) % 2 === 0 ? 1 : 0;
        b.rect(x0 - tw / 2 - 2, armY + 4 + tap, 3, 6).fill(C.white);
        b.rect(x0 + tw / 2 - 1, armY + 5 - tap, 3, 6).fill(C.white);
        fx.rect(-6, headTop - 8, 12, 3).fill({ color: C.white, alpha: 0.5 + 0.5 * tap });
        break;
      }
      case 'reading':
        b.rect(x0 - 6, armY + 2, 12, 8).fill(0xbdbdbd).stroke({ width: 1, color: 0x000000 });
        b.rect(x0, armY + 2, 1, 8).fill(0x000000);
        break;
      case 'running': {
        const on = !anim || Math.floor(t / 400) % 2 === 0;
        fx.rect(-9, headTop - 14, 18, 10).fill(0x000000).stroke({ width: 1, color: C.edge });
        fx.rect(-6, headTop - 11, 3, 1).fill(C.white);
        if (on) fx.rect(-2, headTop - 8, 4, 1).fill(C.white);
        break;
      }
      case 'browsing':
        fx.circle(0, headTop - 9, 5).stroke({ width: 1, color: C.white });
        fx.rect(-5, headTop - 9, 10, 1).fill(C.white);
        break;
      case 'delegating': {
        const wave = anim ? Math.round(Math.sin(t / 200) * 2) : 0;
        b.rect(x0 + tw / 2, armY - 10 + wave, 3, 12).fill(C.white);
        break;
      }
      case 'working': {
        const n = anim ? Math.floor(t / 300) % 4 : 3;
        for (let i = 0; i < n; i++) fx.rect(-6 + i * 5, headTop - 6, 2, 2).fill(C.white);
        break;
      }
      case 'waiting': {
        const on = !anim || Math.floor(t / 450) % 2 === 0;
        fx.circle(0, 0, 13).stroke({ width: 1, color: C.red, alpha: on ? 1 : 0.35 });
        if (on) {
          // "?" in red.
          fx.rect(-3, headTop - 16, 6, 2).fill(C.red);
          fx.rect(2, headTop - 14, 2, 3).fill(C.red);
          fx.rect(-1, headTop - 11, 3, 2).fill(C.red);
          fx.rect(-1, headTop - 7, 2, 2).fill(C.red);
        }
        break;
      }
      case 'done':
        fx.poly([-5, headTop - 9, -2, headTop - 6, 5, headTop - 13]).stroke({ width: 2, color: C.white });
        break;
      case 'error':
        fx.rect(-1, headTop - 16, 3, 7).fill(C.red);
        fx.rect(-1, headTop - 7, 3, 2).fill(C.red);
        break;
      case 'walk':
      case 'idle':
        break;
    }
    this.tagAnchor = { x: sx, y: sy + headTop - 18 };
  }
}

// ---- scene ----

export interface OfficeStats {
  readonly avatars: number;
  readonly walking: number;
  /** Bench seat index per visitor. */
  readonly seats: number[];
  /** Name tag boxes on screen (CSS px, bottom centre). */
  readonly tags: { key: string; x: number; y: number; w: number; h: number }[];
  readonly room: { left: number; top: number; right: number; bottom: number; scale: number };
  readonly resolution: number;
  readonly screen: { width: number; height: number };
}

export class OfficeScene {
  private readonly world = new Container();
  private readonly avatars = new Map<string, AvatarSprite>();
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private readonly leds = new Graphics();
  private readonly tagLayer = new Container();
  private readonly tagLines = new Graphics();
  /** Bench seat index of each visitor sprite. */
  private readonly seats = new Map<string, number>();
  private scale = 1;

  constructor(private readonly app: Application) {
    this.world.sortableChildren = true;
    const room = new Graphics();
    drawRoom(room);
    room.zIndex = -1_000;
    this.world.addChild(room);
    for (const f of FURNITURE) f.tiles.forEach((t, i) => this.world.addChild(drawFurniture(f, t, i)));
    this.leds.zIndex = depth({ x: 0, y: 3 }, 1);
    this.world.addChild(this.leds);
    this.tagLayer.addChild(this.tagLines);
    app.stage.addChild(this.world, this.tagLayer);
    this.fit();
    // Pixi resizes the canvas a frame after the window event, so fit on the renderer's own resize.
    app.renderer.on('resize', () => {
      this.fit();
    });
  }

  /** Scale the room to fit the window, centred. Works in CSS px: with autoDensity the renderer handles the pixel ratio. */
  private fit(): void {
    const box = {
      left: toScreen({ x: 0, y: ROWS }).sx - TILE_W / 2,
      right: toScreen({ x: COLS, y: 0 }).sx + TILE_W / 2,
      top: toScreen({ x: 0, y: 0 }).sy - WALL_H - 20,
      bottom: toScreen({ x: COLS, y: ROWS }).sy,
    };
    const { width, height } = this.app.screen;
    const f = fitRoom({ width, height }, box, width < NARROW_PX ? 0.99 : 0.94);
    this.scale = f.scale;
    this.world.scale.set(f.scale);
    this.world.position.set(f.x, f.y);
  }

  /** Where the room sits on screen, in CSS px (for tests: it must always fit the view). */
  roomOnScreen(): { left: number; top: number; right: number; bottom: number; scale: number } {
    const a = toScreen({ x: 0, y: ROWS });
    const b = toScreen({ x: COLS, y: 0 });
    const t = toScreen({ x: 0, y: 0 });
    const d = toScreen({ x: COLS, y: ROWS });
    const x = (sx: number): number => sx * this.scale + this.world.x;
    const y = (sy: number): number => sy * this.scale + this.world.y;
    return { left: x(a.sx - TILE_W / 2), right: x(b.sx + TILE_W / 2), top: y(t.sy - WALL_H), bottom: y(d.sy), scale: this.scale };
  }

  /** Server rack LEDs: red/white blink on the front faces. */
  private drawLeds(t: number): void {
    const g = this.leds.clear();
    for (const y of [2, 3]) {
      const { sx, sy } = toScreen({ x: 0, y });
      for (let r = 0; r < 5; r++) {
        const on = this.reducedMotion || (Math.floor(t / 250) + r + y) % 3 !== 0;
        g.rect(sx + 8, sy - 50 + r * 9 + 4, 3, 2).fill({ color: r === 0 ? C.red : C.white, alpha: on ? 0.9 : 0.15 });
      }
    }
  }

  update(state: OfficeState, dtMs: number, t: number): void {
    this.drawLeds(t);
    const avatars = Object.values(state.avatars);
    // Create sprites. A visitor who already left (absent, no sprite) is not drawn at all.
    for (const a of avatars) {
      if (this.avatars.has(a.key) || (a.role === 'visitor' && !a.present)) continue;
      const start = a.role === 'visitor' ? SPOTS.door : (SEATS[a.key] ?? SPOTS.door);
      const sprite = new AvatarSprite(a.key, a.label, start, a.role === 'visitor' ? VISITOR_TAG : (TAG[a.key] ?? VISITOR_TAG), Math.max(2, this.app.renderer.resolution));
      if (a.role === 'visitor') this.seats.set(a.key, assignSeat(this.seats.values()));
      this.avatars.set(a.key, sprite);
      this.world.addChild(sprite.root);
      this.tagLayer.addChild(sprite.tagBox);
    }
    // Goals: one tile per avatar (shared stations spread out), in a fixed order.
    const live = avatars.filter((a) => this.avatars.has(a.key)).sort((p, q) => (p.key < q.key ? -1 : 1));
    const goals = spreadGoals(live.map((a) => ({ key: a.key, tile: targetTile(a, this.seats.get(a.key) ?? 0) })));
    for (const a of live) {
      const sprite = this.avatars.get(a.key);
      if (!sprite) continue;
      sprite.setGoal(goals.get(a.key) ?? SPOTS.door, this.reducedMotion);
      sprite.step(dtMs);
      sprite.root.visible = a.present || !sprite.atDoor;
      sprite.draw(a, t, this.reducedMotion);
      // A visitor that has walked back out of the door is gone: free its sprite and seat.
      if (a.role === 'visitor' && !a.present && sprite.atDoor) this.remove(a.key);
    }
    this.layoutTags();
  }

  private remove(key: string): void {
    const sprite = this.avatars.get(key);
    if (!sprite) return;
    sprite.root.destroy({ children: true });
    sprite.tagBox.destroy({ children: true });
    this.avatars.delete(key);
    this.seats.delete(key);
  }

  /** Name tags in screen space: fixed size, never overlapping, with a leader line when moved off the head. */
  private layoutTags(): void {
    const s = Math.max(1, this.scale);
    const boxes: TagBox[] = [];
    for (const [key, sprite] of this.avatars) {
      sprite.tagBox.visible = sprite.root.visible;
      if (!sprite.root.visible) continue;
      boxes.push({ key, x: sprite.tagAnchor.x * this.scale + this.world.x, y: sprite.tagAnchor.y * this.scale + this.world.y, w: sprite.tagW * s, h: sprite.tagH * s });
    }
    const places = layoutTags(boxes, { width: this.app.screen.width, height: this.app.screen.height });
    const lines = this.tagLines.clear();
    for (const b of boxes) {
      const sprite = this.avatars.get(b.key);
      const p = places.get(b.key);
      if (!sprite || !p) continue;
      sprite.tagBox.scale.set(s);
      sprite.tagBox.position.set(p.x, p.y);
      if (p.moved) lines.moveTo(b.x, b.y).lineTo(p.x, p.y).stroke({ width: 1, color: C.dim, alpha: 0.8 });
    }
  }

  /** Counts and layout for tests and the fps check. */
  stats(): OfficeStats {
    let walking = 0;
    for (const s of this.avatars.values()) if (s.isWalking) walking += 1;
    const tags = [...this.avatars.values()]
      .filter((s) => s.tagBox.visible)
      .map((s) => ({ key: s.key, x: s.tagBox.x, y: s.tagBox.y, w: s.tagW * s.tagBox.scale.x, h: s.tagH * s.tagBox.scale.x }));
    return {
      avatars: this.avatars.size,
      walking,
      seats: [...this.seats.values()],
      tags,
      room: this.roomOnScreen(),
      resolution: this.app.renderer.resolution,
      screen: { width: this.app.screen.width, height: this.app.screen.height },
    };
  }

  /** Drop every avatar sprite (demo loop restart). */
  reset(): void {
    for (const key of [...this.avatars.keys()]) this.remove(key);
    this.seats.clear();
  }
}
