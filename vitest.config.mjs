import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests run against core's source, so they do not depend on core/dist being built.
const coreSrc = fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url));

// The relay's workerd test spawns `wrangler dev` (heavy CPU for ~10 s), which made
// CPU-bound timing tests in other files flaky (e.g. the redact BUG-01 50 ms check).
// It lives in its own project with a higher groupOrder, so it runs alone AFTER all
// other test files are done (V1-01 L-3).
const WORKERD_TESTS = ['packages/relay/test/workerd.test.ts', 'packages/relay/test/workerd-ws.test.ts', 'packages/relay/test/workerd-bridge.test.ts'];

export default defineConfig({
  resolve: { alias: { '@agent-office/core': coreSrc } },
  test: {
    environment: 'node',
    // Builds the emit bundle ONCE before any test file runs (parallel per-file builds raced).
    globalSetup: ['./vitest.global-setup.mjs'],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'scripts/test/**/*.test.mjs'],
          exclude: ['**/node_modules/**', ...WORKERD_TESTS],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'workerd',
          include: WORKERD_TESTS,
          sequence: { groupOrder: 1 },
          // One wrangler dev at a time (two in parallel fight over workerd's sockets).
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**/*.ts'],
      exclude: ['packages/core/src/index.ts'],
      reporter: ['text', 'html'],
      // Plan §14: >= 90% branch coverage on core.
      thresholds: { branches: 90 },
    },
  },
});
