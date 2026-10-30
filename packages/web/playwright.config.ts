// Browser smoke tests for the web UI (W-02). Not part of `npm test`: they need a
// Chromium and a full build. Run: `npm run test:e2e` (see docs/e2e.md).
import { defineConfig } from '@playwright/test';

// Optional: use an already installed Chromium (the cloud sandbox has one) instead of `playwright install`.
const executablePath = process.env.AGENT_OFFICE_CHROMIUM || undefined;

export default defineConfig({
  testDir: 'e2e',
  outputDir: '../../test-results',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    launchOptions: { executablePath, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } },
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } },
  ],
});
