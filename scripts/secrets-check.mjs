#!/usr/bin/env node
// `npm run secrets:check` (V1-07): lists the relay Worker's secret NAMES with
// `wrangler secret list` and checks the required ones exist. Never reads or prints values.
//
// Exit codes: 0 = ok, 1 = a required secret is missing, 2 = could not check.
// Required now: INGEST_TOKEN, ACCESS_TEAM_DOMAIN, ACCESS_AUD (V1-02) and BRIDGE_TOKEN (V1-04).

import { isMain } from './lib/is-main.mjs';
import { defaultDeps, secretsCheck } from './lib/relay.mjs';

if (isMain(import.meta.url)) {
  if (process.argv.length > 2) {
    process.stderr.write('usage: npm run secrets:check   (takes no options)\n');
    process.exitCode = 2;
  } else {
    process.exitCode = secretsCheck(defaultDeps());
  }
}
