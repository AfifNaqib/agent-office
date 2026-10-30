#!/usr/bin/env node
// Merges the Agent Office hook block into a Claude settings file (V0-02).
//
//   npm run install-hooks                       user settings (~/.claude/settings.json), hooks only
//   npm run install-hooks -- <repoPath>         one repo: <repo>/.claude/settings.json (+ the script in <repo>/.claude/hooks/)
//   npm run setup:pc                            same as the first line, plus data folder, token and config.json
//
// Options: --dry-run (show what would change, write nothing), --uninstall (remove only our hooks),
//          --settings <file> (use this settings file instead of the default).
//
// The merge keeps every other key and every other hook, replaces only our own entries (a hook
// `node <...>/agent-office-emit.mjs`), so running it twice changes nothing. A settings file that is
// not valid JSON is never touched. No token is ever written into a settings file or a repo.
// Folders: AGENT_OFFICE_HOME (data folder, default ~/.agent-office), CLAUDE_CONFIG_DIR (default ~/.claude).

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isMain } from './lib/is-main.mjs';
import { run } from './lib/install.mjs';

export const USAGE = 'usage: install-hooks.mjs [<repoPath>] [--settings <file>] [--dry-run] [--uninstall]';

/** Parse argv. Throws a readable Error for anything unknown. */
export function parseArgs(argv, { allowRepo }) {
  const o = { dryRun: false, uninstall: false, settingsFile: undefined, repo: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--uninstall') o.uninstall = true;
    else if (a === '--settings') {
      const v = argv[(i += 1)];
      if (!v || v.startsWith('--')) throw new Error(`--settings needs a file path\n${USAGE}`);
      o.settingsFile = resolve(v);
    } else if (a.startsWith('--')) throw new Error(`unknown option ${a}\n${USAGE}`);
    else if (allowRepo && o.repo === undefined) o.repo = resolve(a);
    else throw new Error(`unexpected argument ${a}\n${USAGE}`);
  }
  return o;
}

/** Runs the install; `withData` = setup:pc (also token + config.json). Returns the lines to print. */
export async function main(argv, env, { withData }) {
  const o = parseArgs(argv, { allowRepo: !withData });
  if (o.repo !== undefined && !existsSync(join(o.repo, '.git'))) throw new Error(`${o.repo} is not a git repository`);
  let emitBuilt;
  if (!o.uninstall) {
    const { buildEmit, OUTFILE } = await import('../packages/emit/build.mjs');
    emitBuilt = o.dryRun ? OUTFILE : await buildEmit(); // a dry run builds and writes nothing
  }
  const r = run({ target: o.repo ? 'repo' : 'user', repo: o.repo, settingsFile: o.settingsFile, emitBuilt, withData, dryRun: o.dryRun, uninstall: o.uninstall, env });
  return r.lines;
}

export function cli(withData) {
  main(process.argv.slice(2), process.env, { withData }).then(
    (lines) => {
      process.stdout.write(`${lines.join('\n')}\n`);
      if (withData && !lines.includes('dry run: nothing was written') && !process.argv.includes('--uninstall')) {
        process.stdout.write('next: npm run bridge   (docs/setup-pc.md)\n');
      }
    },
    (err) => {
      process.stderr.write(`${withData ? 'setup:pc' : 'install-hooks'}: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}

if (isMain(import.meta.url)) cli(false);
