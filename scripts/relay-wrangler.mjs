#!/usr/bin/env node
// Runs the repo's own wrangler for packages/relay with this node, so it works when
// `npx` is not on PATH (the PO's PATH is locked):
//
//   npm run relay:wrangler -- secret put INGEST_TOKEN
//   & "$node\node.exe" scripts\relay-wrangler.mjs secret put INGEST_TOKEN
//
// Arguments are passed through unchanged (no shell). stdin is passed through too, so
// a token can be piped in instead of pasted.

import { spawnSync } from 'node:child_process';
import { isMain } from './lib/is-main.mjs';
import { MIN_NODE, RELAY_DIR, findWrangler, nodeTooOld } from './lib/relay.mjs';

if (isMain(import.meta.url)) {
  const wrangler = findWrangler();
  if (nodeTooOld()) {
    process.stderr.write(
      `error: Node ${process.version} is too old; wrangler needs Node ${MIN_NODE} or newer.\n`,
    );
    process.exitCode = 2;
  } else if (!wrangler) {
    process.stderr.write('error: wrangler not found. Run `npm ci` in the repo folder first.\n');
    process.exitCode = 2;
  } else {
    const r = spawnSync(process.execPath, [wrangler, ...process.argv.slice(2)], {
      cwd: RELAY_DIR,
      shell: false,
      stdio: 'inherit',
    });
    if (r.error) process.stderr.write(`error: could not start wrangler: ${r.error.message}\n`);
    process.exitCode = r.status ?? 1;
  }
}
