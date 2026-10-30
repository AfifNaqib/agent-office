// Bundles src/index.ts into dist/agent-office-bridge.mjs. core (with zod) and the
// gen-token helper are bundled from source; hono, @hono/node-server and ws stay
// imports from node_modules (run it from the repo, after `npm ci`).
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
export const OUTFILE = join(here, 'dist', 'agent-office-bridge.mjs');

export async function buildBridge() {
  mkdirSync(dirname(OUTFILE), { recursive: true });
  await build({
    entryPoints: [join(here, 'src', 'index.ts')],
    outfile: OUTFILE,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    alias: { '@agent-office/core': join(here, '..', 'core', 'src', 'index.ts') },
    external: ['hono', 'hono/*', '@hono/node-server', 'ws'],
    legalComments: 'none',
    logLevel: 'warning',
    tsconfig: join(here, 'tsconfig.json'),
  });
  return OUTFILE;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildBridge();
}
