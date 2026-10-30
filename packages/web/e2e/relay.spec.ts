// V1-05 AC: the built UI served by the relay Worker (`wrangler dev`, Workers static
// assets behind the Access guard) with a stubbed Access JWT shows replayed cloud
// events, then a live one; no CSP violations; fits 390x844. Runs in both projects
// (desktop 1440x900, phone 390x844 @3x).
import type { Page } from '@playwright/test';
import { expect, test, type RelayRig } from './relay-harness.js';

interface OfficeHook {
  state(): { avatars: Record<string, { activity: string; present: boolean }> };
  stats(): { avatars: number };
}
const hook = <T>(page: Page, fn: (o: OfficeHook) => T): Promise<T> => page.evaluate<T>(`(${fn.toString()})(window.__office)`);

/** Collects page errors, console errors/warnings and CSP violations (also ones the console would not show). */
async function watch(page: Page): Promise<() => Promise<string[]>> {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // "GL Driver Message" warnings come from the software GL in headless Chromium, not from the app.
    if (m.type() === 'error' || (m.type() === 'warning' && !m.text().includes('GL Driver Message'))) problems.push(`console ${m.type()}: ${m.text()}`);
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  return async () => [...problems, ...(await page.evaluate<string[]>('window.__csp')).map((v) => `csp: ${v}`)];
}

let n = 0;
const sid = (): string => `cloud-${Date.now().toString(36)}-${++n}`;

async function seed(relay: RelayRig, sessionId: string): Promise<void> {
  await relay.playTeamRun(sessionId, 'portfolio', (e) => e.kind === 'notification', 2_000);
}

test.describe('office UI on the relay', () => {
  test('replayed cloud events, a live event, no CSP violations, fits the screen', async ({ page, relay }) => {
    const sessionId = sid();
    await seed(relay, sessionId);
    await relay.login();
    const problems = await watch(page);
    const res = await page.goto(`${relay.url}/?debug`);
    expect(res?.headers()['content-security-policy']).toContain("script-src 'self'");
    await expect(page.locator('#status')).toContainText('LIVE · relay', { timeout: 20_000 });
    await expect(page.locator('#status')).toContainText('Cloud');
    await expect(page.locator('#lobby button.session:not(.follow)').first()).toBeVisible();
    await expect(page.locator('#office canvas')).toBeVisible();
    await expect.poll(() => hook(page, (o) => o.stats().avatars)).toBeGreaterThanOrEqual(1);
    await expect(page.locator('#feed .item').first()).toBeVisible();
    await expect(page.locator('#relogin')).toBeHidden();

    // A live event over /ws/ui.
    const text = `live check ${sessionId}`;
    await relay.ingest(relay.event({ kind: 'notification', sessionId, text }));
    await expect(page.locator('#feed')).toContainText(text, { timeout: 5_000 });

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(await problems()).toEqual([]);
  });

  test('without the Access JWT nothing of the app is served (401 JSON for / and the bundle)', async ({ page, relay }) => {
    const res = await page.goto(`${relay.url}/`);
    expect(res?.status()).toBe(401);
    expect(await page.content()).not.toContain('id="office"');
    const js = await page.request.get(`${relay.url}/assets/index.js`);
    expect(js.status()).toBe(401);
  });

  test('login expiry: the socket closes 4401, the probe gets 401, the page offers "Log in again"', async ({ page, relay }, info) => {
    test.skip(info.project.name !== 'desktop', 'one run is enough (waits ~35 s)');
    test.setTimeout(90_000);
    const sessionId = sid();
    await relay.ingest(relay.event({ kind: 'session.start', sessionId }));
    await relay.login(2); // exp in 2 s; guard and socket allow 30 s more
    const problems = await watch(page);
    await page.goto(`${relay.url}/`);
    await expect(page.locator('#status')).toContainText('LIVE · relay', { timeout: 20_000 });
    await page.waitForTimeout(34_000);
    // The next stored event makes the DO close the expired socket with 4401.
    await relay.ingest(relay.event({ kind: 'notification', sessionId, text: 'after expiry' }));
    await expect(page.locator('#status')).toContainText('login expired', { timeout: 10_000 });
    await expect(page.locator('#relogin')).toBeVisible();
    await expect(page.locator('#relogin')).toHaveText('Log in again');
    await expect(page.locator('#relogin')).toHaveAttribute('href', '/');
    await expect(page.locator('#feed')).not.toContainText('after expiry');
    // The failed login probe (401) shows up as a console error in Chromium; nothing else may.
    expect((await problems()).filter((p) => !/status of 401/.test(p))).toEqual([]);
  });
});
