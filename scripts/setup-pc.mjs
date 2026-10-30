#!/usr/bin/env node
// `npm run setup:pc`: one-time setup on the PO's PC (V0-02, plan D-05).
//
//   1. creates the data folder (AGENT_OFFICE_HOME or ~/.agent-office)
//   2. creates local-token if missing (an existing valid one is kept, a broken one stops the script)
//   3. creates/completes config.json (port, claudePath when claude.exe is where we expect it)
//   4. copies the built emit script to <data folder>/hooks/agent-office-emit.mjs
//   5. merges the hooks into ~/.claude/settings.json (one-time backup of the original first)
//
// Options: --dry-run, --uninstall (removes only our hooks; keeps token, config and the copied script),
//          --settings <file>. Details in install-hooks.mjs.

import { isMain } from './lib/is-main.mjs';
import { cli } from './install-hooks.mjs';

if (isMain(import.meta.url)) cli(true);
