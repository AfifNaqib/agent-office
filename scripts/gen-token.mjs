#!/usr/bin/env node
// Prints a new random token (see lib/token.mjs). Used for INGEST_TOKEN, BRIDGE_TOKEN
// and the local token.
//
//   npm run gen-token
//
// The token is printed to stdout only. Never commit it or paste it into a repo;
// store it with `wrangler secret put`, a cloud network secret, or the PC config.

import { isMain } from './lib/is-main.mjs';
import { genToken } from './lib/token.mjs';

export { TOKEN_BYTES, genToken } from './lib/token.mjs';

if (isMain(import.meta.url)) {
  process.stdout.write(`${genToken()}\n`);
}
