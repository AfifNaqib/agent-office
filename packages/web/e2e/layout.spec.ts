// UI-L8: name tags never overlap, visitors get their own seats, the canvas is drawn at
// the device pixel ratio (1x / 2x / 3x), and the room stays legible on a phone.
import type { OfficeEvent } from '@agent-office/core';
import type { Page } from '@playwright/test';
import { pickResolution } from '../src/office/view.js';
import { expect, test, type BridgeRig } from './harness.js';

type Stats = { avatars: number; walking: number; seats: number[]; tags: { key: string; x: number; y: number; w: number; h: number }[]; room: { left: number; top: number; right: number; bottom: number; scale: number }; resolution: number; screen: { width: number; height: number } };
const stats = (page: Page): Promise<Stats> => page.evaluate<Stats>('window.__office.stats()');

const VISITORS = ['Explore', 'Plan', 'general-purpose', 'code-reviewer', 'security-auditor', 'doc-writer', 'data-miner', 'release-bot'];
const DESKS = ['architect', 'coder', 'tester', 'manager'];

/** JEBON, four desk agents running Bash (all go to the server rack) and eight visitors, all busy. */
async function crowd(bridge: BridgeRig, visitors = VISITORS): Promise<void> {
  const sub = (t: string): OfficeEvent['actor'] => ({ kind: 'subagent', agentType: t, agentId: `${t}-1` });
  let n = 0;
  const run = (actor: OfficeEvent['actor'], name: string) => bridge.post(bridge.event({ kind: 'tool.start', actor, sessionId: 'crowd', tool: { name, useId: `c-${++n}`, summary: 'x' } }));
  await run({ kind: 'main', agentType: null, agentId: null }, 'Bash');
  for (const d of DESKS) await run(sub(d), 'Bash');
  for (const v of visitors) await run(sub(v), 'Read');
}

async function open(page: Page, bridge: BridgeRig, expected: number): Promise<void> {
  await page.goto(`${bridge.url}/?debug`);
  await expect(page.locator('#status')).toContainText('LIVE', { timeout: 15_000 });
  await expect.poll(async () => (await stats(page)).avatars, { timeout: 10_000 }).toBe(expected);
}

const overlap = (a: Stats['tags'][number], b: Stats['tags'][number]): boolean => Math.abs(a.x - b.x) * 2 < a.w + b.w && a.y - a.h < b.y && b.y - b.h < a.y;

test.describe('layout', () => {
  test('13 avatars: no two name tags overlap, tags stay on screen, visitors sit on 8 different seats', async ({ page, bridge }) => {
    await crowd(bridge);
    await open(page, bridge, 13);
    // Let everyone arrive (they walk in from the door), then check a few frames apart.
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(1_500);
      const s = await stats(page);
      expect(s.tags).toHaveLength(13);
      for (const [i1, a] of s.tags.entries()) {
        expect(a.x - a.w / 2, `${a.key} left`).toBeGreaterThanOrEqual(-0.5);
        expect(a.x + a.w / 2, `${a.key} right`).toBeLessThanOrEqual(s.screen.width + 0.5);
        expect(a.y - a.h, `${a.key} top`).toBeGreaterThanOrEqual(-0.5); // B2
        expect(a.y, `${a.key} bottom`).toBeLessThanOrEqual(s.screen.height + 0.5);
        for (const b of s.tags.slice(i1 + 1)) expect(overlap(a, b), `${a.key} overlaps ${b.key} at ${i}`).toBe(false);
      }
      expect(new Set(s.seats).size).toBe(8);
    }
  });

  test('visitors that leave free their sprite and seat', async ({ page, bridge }) => {
    await crowd(bridge, VISITORS.slice(0, 3));
    await open(page, bridge, 8);
    expect((await stats(page)).seats).toHaveLength(3);
    // The session ends: visitors walk out of the door and are freed; the five desk avatars stay.
    await bridge.post(bridge.event({ kind: 'session.end', sessionId: 'crowd' }));
    await expect.poll(async () => (await stats(page)).avatars, { timeout: 20_000 }).toBe(5);
    expect((await stats(page)).seats).toEqual([]);
  });

  test('phone: the room fills the width and tags are at least 10 px text', async ({ page, bridge }, info) => {
    test.skip(info.project.name !== 'phone', 'phone project only');
    await crowd(bridge);
    await open(page, bridge, 13);
    await page.waitForTimeout(2_000);
    const s = await stats(page);
    expect(s.room.right - s.room.left).toBeGreaterThan(s.screen.width * 0.97);
    expect(s.room.left).toBeGreaterThanOrEqual(-1);
    expect(s.room.right).toBeLessThanOrEqual(s.screen.width + 1);
    expect(Math.min(...s.tags.map((t) => t.h))).toBeGreaterThanOrEqual(13); // 10 px font + padding
    expect(s.resolution).toBe(2); // 390x844 @3x is drawn at the 2x cap
    await page.screenshot({ path: `${info.outputDir}/phone.png` });
  });
});

for (const dpr of [1, 2, 3]) {
  test(`HiDPI ${dpr}x: canvas is drawn at min(${dpr}, 2)x and the room fits`, async ({ browser, bridge }, info) => {
    test.skip(info.project.name !== 'desktop', 'runs once, with its own contexts');
    await crowd(bridge, VISITORS.slice(0, 2));
    for (const [width, height] of [[1440, 900], [800, 600]] as const) {
      const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
      const page = await ctx.newPage();
      await open(page, bridge, 7);
      const s = await stats(page);
      const canvas = await page.locator('#office canvas').evaluate((c: HTMLCanvasElement) => ({ w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight }));
      expect(s.resolution).toBe(pickResolution(dpr, canvas.cw, canvas.ch)); // capped on a big canvas
      if (width === 800) expect(s.resolution).toBe(Math.min(dpr, 2)); // phone/laptop size: device ratio, capped at 2x
      expect(s.resolution).toBeLessThanOrEqual(2);
      if (width === 1440) expect(s.resolution).toBe(Math.min(dpr, 2)); // 1440x900 canvas is far below the pixel budget
      expect(canvas.w).toBe(Math.round(canvas.cw * s.resolution));
      expect(canvas.h).toBe(Math.round(canvas.ch * s.resolution));
      expect(Math.abs(s.screen.width - canvas.cw)).toBeLessThan(1); // clientWidth rounds a fractional pane width
      expect(Math.abs(s.screen.height - canvas.ch)).toBeLessThan(1);
      expect(s.room.left).toBeGreaterThanOrEqual(-1);
      expect(s.room.top).toBeGreaterThanOrEqual(-1);
      expect(s.room.right).toBeLessThanOrEqual(s.screen.width + 1);
      expect(s.room.bottom).toBeLessThanOrEqual(s.screen.height + 1);
      await page.screenshot({ path: `${info.outputDir}/hidpi-${dpr}x-${width}.png` });
      await ctx.close();
    }
  });
}
