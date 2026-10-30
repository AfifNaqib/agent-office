// Runs once before all test files:
// - build the emit bundle that the emit tests spawn;
// - build the web app when packages/web/dist is missing (V1-05): the relay's
//   wrangler configs read it as their static assets, so `wrangler dev` in the
//   workerd tests needs it. An existing build is reused (CI runs tests before build).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildEmit } from './packages/emit/build.mjs';

const webDir = fileURLToPath(new URL('./packages/web/', import.meta.url));

export default async function setup() {
  await buildEmit();
  if (!existsSync(`${webDir}dist/index.html`)) {
    const { build } = await import('vite');
    await build({ root: webDir, logLevel: 'warn' });
  }
}
