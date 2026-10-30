// V0-04 AC: 30 fps with 6 walking avatars. Six actors (JEBON, four desk agents and a
// visitor) are sent to different stations every 2.5 s through the real bridge, so
// they keep walking. The frame rate is counted with requestAnimationFrame in the page.
//
// CAVEAT: headless Chromium here renders with software GL (SwiftShader), which is far
// slower than a real GPU, and the phone project also throttles the CPU 4x. The floor
// below is therefore well under the 30 fps target; it only catches a collapse. The
// numbers are written to test-results/fps.json and recorded in docs/e2e.md.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OfficeEvent } from '@agent-office/core';
import { expect, test, type BridgeRig } from './harness.js';

const FLOOR_FPS = 6;
const MEASURE_MS = 6_000;
const ROUND_MS = 2_500;
/** Bash -> server rack, WebFetch -> shelf, Agent -> whiteboard, Read -> own desk. */
const STATIONS = ['Bash', 'WebFetch', 'Agent', 'Read'] as const;
const ACTORS: OfficeEvent['actor'][] = [
  { kind: 'main', agentType: null, agentId: null },
  ...['architect', 'coder', 'tester', 'manager', 'Explore'].map((t) => ({ kind: 'subagent' as const, agentType: t, agentId: `${t}-1` })),
];

async function sendRound(bridge: BridgeRig, round: number): Promise<void> {
  for (const [i, actor] of ACTORS.entries()) {
    const name = STATIONS[(round + i) % STATIONS.length] ?? 'Read';
    await bridge.post(bridge.event({ kind: 'tool.start', actor, sessionId: 'walkers', tool: { name, useId: `w-${round}-${i}`, summary: 'x' } }));
  }
}

test('6 avatars walking at once: frame rate stays above the floor', async ({ page, bridge }, info) => {
  const phone = info.project.name === 'phone';
  const walkers = ACTORS.map((a) => a.agentType);
  expect(walkers).toHaveLength(6);

  await page.goto(`${bridge.url}/?debug&fps`);
  await expect(page.locator('#status')).toContainText('LIVE', { timeout: 15_000 });
  const cdp = await page.context().newCDPSession(page);
  if (phone) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  let round = 0;
  await sendRound(bridge, round++);
  let stopped = false;
  const driver = setInterval(() => {
    if (!stopped) sendRound(bridge, round++).catch(() => undefined); // the bridge is killed when the test ends
  }, ROUND_MS);

  try {
    await expect.poll(() => page.evaluate('window.__office.stats().avatars'), { timeout: 10_000 }).toBe(6);
    // Count walkers while the frame rate is measured: sample twice a second.
    const sampler = page.evaluate(
      (ms) =>
        new Promise<{ fps: number; maxWalking: number }>((resolve) => {
          const office = (window as unknown as { __office: { stats(): { walking: number } } }).__office;
          let frames = 0;
          let maxWalking = 0;
          const t0 = performance.now();
          const tick = (): void => {
            frames += 1;
            maxWalking = Math.max(maxWalking, office.stats().walking);
            if (performance.now() - t0 >= ms) resolve({ fps: (frames * 1000) / (performance.now() - t0), maxWalking });
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
      MEASURE_MS,
    );
    const { fps, maxWalking } = await sampler;
    const row = { project: info.project.name, viewport: page.viewportSize(), dpr: phone ? 3 : 1, cpuThrottle: phone ? 4 : 1, avatars: 6, maxWalkingAtOnce: maxWalking, fps: Math.round(fps * 10) / 10, floor: FLOOR_FPS, when: new Date().toISOString() };
    const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test-results');
    mkdirSync(out, { recursive: true });
    appendFileSync(join(out, 'fps.json'), JSON.stringify(row) + '\n');
    info.annotations.push({ type: 'fps', description: JSON.stringify(row) });
    process.stdout.write(`fps ${JSON.stringify(row)}\n`);

    expect(maxWalking, 'avatars were not walking').toBeGreaterThanOrEqual(5);
    expect(fps).toBeGreaterThanOrEqual(FLOOR_FPS);
  } finally {
    stopped = true;
    clearInterval(driver);
  }
});
