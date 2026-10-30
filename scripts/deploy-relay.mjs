#!/usr/bin/env node
// `npm run deploy:relay` (V1-07): deploys packages/relay with `wrangler deploy`.
// Refuses when the working tree is dirty (tracked changes anywhere, or untracked
// files in packages/relay or packages/core) or when `secrets:check` fails.
// Builds the office web app (packages/web, the relay's static assets, V1-05) right
// before `wrangler deploy`. The deployed version is labelled with the git commit.
// See docs/setup-cloudflare.md.

import { isMain } from './lib/is-main.mjs';
import { defaultDeps, deployRelay } from './lib/relay.mjs';

if (isMain(import.meta.url)) {
  if (process.argv.length > 2) {
    process.stderr.write('usage: npm run deploy:relay   (takes no options)\n');
    process.exitCode = 2;
  } else {
    process.exitCode = deployRelay(defaultDeps());
  }
}
