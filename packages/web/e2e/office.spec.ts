// W-02 / W-01: the built UI served by the real built bridge, fed with the observed
// team run. Runs at 1440x900 (desktop) and 390x844 @3x (phone), see playwright.config.ts.
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test, type BridgeRig } from './harness.js';

interface OfficeHook {
  state(): { avatars: Record<string, { activity: string; present: boolean }> };
  stats(): { avatars: number; walking: number };
}
const hook = <T>(page: Page, fn: (o: OfficeHook) => T): Promise<T> => page.evaluate<T>(`(${fn.toString()})(window.__office)`);

/** Two sessions, both paused at the permission prompt (main is waiting). */
async function seed(bridge: BridgeRig): Promise<void> {
  const atNotification = (e: { kind: string }): boolean => e.kind === 'notification';
  await bridge.playTeamRun('sess-aaaa', 'agent-office', atNotification, 3_000);
  await bridge.playTeamRun('sess-bbbb', 'portfolio', atNotification, 2_000);
}

async function open(page: Page, bridge: BridgeRig): Promise<string[]> {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // "GL Driver Message" warnings come from the software GL in headless Chromium, not from the app.
    if (m.type() === 'error' || (m.type() === 'warning' && !m.text().includes('GL Driver Message'))) problems.push(`console ${m.type()}: ${m.text()}`);
  });
  await page.goto(`${bridge.url}/?debug`);
  await expect(page.locator('#status')).toContainText('LIVE', { timeout: 15_000 });
  await expect(page.locator('#lobby button.session:not(.follow)')).toHaveCount(2);
  return problems;
}

test.describe('office UI', () => {
  test('loads clean, fits the screen, shows a live avatar and a pending card', async ({ page, bridge }) => {
    await seed(bridge);
    const problems = await open(page, bridge);
    await expect.poll(() => hook(page, (o) => o.state().avatars.main?.activity)).toBe('waiting');
    expect((await hook(page, (o) => o.stats())).avatars).toBeGreaterThanOrEqual(3);
    await expect(page.locator('#feed .card.pending')).toContainText('Waiting in Claude');
    await expect(page.locator('#office canvas')).toBeVisible();

    const overflow = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - window.innerWidth, body: document.body.scrollWidth - window.innerWidth }));
    expect(overflow.doc).toBeLessThanOrEqual(0);
    expect(overflow.body).toBeLessThanOrEqual(0);
    expect(problems).toEqual([]);
  });

  test('window.__office exists only with ?debug', async ({ page, bridge }) => {
    await page.goto(`${bridge.url}/`);
    await expect(page.locator('#status')).toContainText('LIVE', { timeout: 15_000 });
    expect(await page.evaluate('typeof window.__office')).toBe('undefined');
  });

  test('axe finds no violations', async ({ page, bridge }) => {
    await seed(bridge);
    await open(page, bridge);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });

  test('W-01: a focused lobby button keeps focus while the lobby ticks, and Enter / Space pin and unpin', async ({ page, bridge }) => {
    await seed(bridge);
    await open(page, bridge);
    const rows = page.locator('#lobby button.session:not(.follow)');
    const shownRepo = (await page.locator('#lobby button[aria-pressed="true"]:not(.follow) .repo').textContent()) ?? '';
    const other = rows.filter({ hasNotText: shownRepo }).first();
    await other.focus();
    await other.evaluate((el) => {
      el.setAttribute('data-probe', 'same-node');
    });
    const before = (await other.locator('.meta').textContent()) ?? '';

    // 6 s of ticking, with new events arriving on the other session, so "ago", order and status all move.
    for (let i = 0; i < 6; i++) {
      await bridge.post(bridge.event({ kind: 'tool.start', sessionId: 'sess-aaaa', tool: { name: 'Read', useId: `tick-${i}`, summary: 'README.md' } }));
      await page.waitForTimeout(1_000);
      const focus = await page.evaluate(() => ({ probe: document.activeElement?.getAttribute('data-probe'), inLobby: document.activeElement?.closest('#lobby') !== null }));
      expect(focus, `focus lost after ${i + 1} s`).toEqual({ probe: 'same-node', inLobby: true });
    }
    expect((await other.locator('.meta').textContent()) ?? '').not.toBe(before); // the "ago" text did move

    await page.keyboard.press('Enter'); // pin the focused session
    await expect(other).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#lobby button.follow')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#status')).toContainText(await other.locator('.repo').innerText());
    await expect(other).toBeFocused();

    await page.locator('#lobby button.follow').focus();
    await page.keyboard.press('Space'); // follow newest again
    await expect(page.locator('#lobby button.follow')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#lobby button.follow')).toBeFocused();
  });

  test('B3: when the focused session button is removed, focus moves to a neighbouring button, never BODY', async ({ page, bridge }) => {
    await seed(bridge);
    await open(page, bridge);
    // Drive the real Panel synchronously (debug hook) so the 1 s tick cannot interfere.
    const result = await page.evaluate(() => {
      const w = window as unknown as { __office: { panel: { renderLobby(e: unknown[], shown: string | null, pinned: string | null, now: number): void } } };
      const entry = (key: string) => ({ key, sessionId: key, source: 'local', repo: key, status: 'idle', lastEventAt: Date.now() });
      const rows = (keys: string[]) => keys.map(entry);
      const out: Record<string, string> = {};
      const focusedLabel = (): string => `${document.activeElement?.tagName}:${document.activeElement?.className.replace(/\s+/g, '.')}:${document.activeElement?.querySelector('.repo')?.textContent ?? ''}`;
      const focusRepo = (repo: string): void => {
        for (const b of document.querySelectorAll<HTMLButtonElement>('#lobby button.session:not(.follow)')) if (b.querySelector('.repo')?.textContent === repo) b.focus();
      };
      const p = w.__office.panel;
      p.renderLobby(rows(['k1', 'k2', 'k3']), null, null, Date.now());
      focusRepo('k2');
      p.renderLobby(rows(['k1', 'k3']), null, null, Date.now()); // middle removed -> next
      out.middle = focusedLabel();
      focusRepo('k3');
      p.renderLobby(rows(['k1']), null, null, Date.now()); // last removed -> previous
      out.last = focusedLabel();
      p.renderLobby([], null, null, Date.now()); // only one left, removed -> Follow newest
      out.only = focusedLabel();
      return out;
    });
    expect(result.middle).toContain(':k3');
    expect(result.last).toContain(':k1');
    expect(result.only).toMatch(/^BUTTON:session\.follow/);
  });
});
