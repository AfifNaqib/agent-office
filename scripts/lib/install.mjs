// Orchestration for `npm run setup:pc` and `npm run install-hooks`. Everything that can fail
// (settings file, config file, token file, paths) is checked BEFORE the first write, and the
// settings file is written last, so it never points at a script that is not there yet.
import { existsSync, mkdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMIT_NAME, assertSafeEmitPath, fillTemplate, mergeHooks, removeHooks, summarizeChange } from './hooks-merge.mjs';
import { SettingsError, backupOnce, parseJsonObject, readSettings, readTextFile, serialize, writeAtomic } from './settings-file.mjs';
import { checkToken, claudeDirOf, copyEmit, dataDirOf, ensureToken, planConfig, userEmitPath, writeConfig } from './setup-data.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadTemplate(name) {
  const text = readTextFile(join(ROOT, 'hooks-config', name), 1024 * 1024);
  if (text === null) throw new SettingsError(`missing template hooks-config/${name}`);
  return parseJsonObject(text, `hooks-config/${name}`);
}

/**
 * @param {object} o
 * @param {'user' | 'repo'} o.target
 * @param {string} [o.repo]            repo root, target 'repo' only
 * @param {string} [o.settingsFile]    override of the settings file path
 * @param {string} [o.emitBuilt]       the built emit bundle to copy (not needed for uninstall)
 * @param {boolean} [o.withData]       also create token + config.json (setup:pc)
 * @param {boolean} [o.dryRun]
 * @param {boolean} [o.uninstall]
 * @param {Record<string, string | undefined>} o.env
 * @param {NodeJS.Platform} [o.platform]
 * @param {number} [o.now]
 * @param {(p: string) => boolean} [o.fileExists]
 * @returns {{ lines: string[], changed: boolean, settingsFile: string, backup: string | null }}
 */
export function run(o) {
  const { env, dryRun = false, uninstall = false, withData = false, platform = process.platform, now = Date.now(), fileExists = existsSync } = o;
  const user = o.target === 'user';
  const dataDir = dataDirOf(env);
  const dest = user ? userEmitPath(dataDir) : join(o.repo, '.claude', 'hooks', EMIT_NAME);
  const settingsFile = o.settingsFile ?? (user ? join(claudeDirOf(env), 'settings.json') : join(o.repo, '.claude', 'settings.json'));
  const lines = [];
  const say = (l) => lines.push(l);

  // 1. Checks only. Nothing is written until all of them pass.
  if (user && !uninstall) assertSafeEmitPath(dest);
  if (!uninstall && !o.emitBuilt) throw new Error('internal: emitBuilt is required');
  const { settings: before, text } = readSettings(settingsFile);
  const tokenStatus = user && withData && !uninstall ? checkToken(dataDir) : null;
  const cfg = user && withData && !uninstall ? planConfig(dataDir, { env, platform, fileExists }) : null;
  const template = uninstall ? null : fillTemplate(loadTemplate(user ? 'user-settings.json' : 'repo-settings.json'), dest);
  const after = uninstall ? removeHooks(before) : mergeHooks(before, template);
  const changed = JSON.stringify(after) !== JSON.stringify(before);
  const diff = summarizeChange(before, after);

  // 2. Report / dry run.
  say(`settings: ${settingsFile}`);
  if (!uninstall) say(`emit script: ${dest}`);
  if (tokenStatus) say(`token: ${tokenStatus === 'create' ? 'will be created' : 'kept'} (${join(dataDir, 'local-token')})`);
  if (cfg) say(`config: ${cfg.changed ? (cfg.text === null ? 'will be created' : 'will be completed') : 'kept'} (${cfg.file})`);
  say(changed ? `${diff.length} hook line(s) change:` : 'hooks: already up to date');
  for (const l of diff) say(`  ${l}`);
  for (const w of cfg?.warnings ?? []) say(`warning: ${w}`);
  if (dryRun) {
    say('dry run: nothing was written');
    return { lines, changed, settingsFile, backup: null };
  }

  // 3. Writes. Data first, settings last.
  if (user && !uninstall) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    if (withData) {
      ensureToken(dataDir);
      if (cfg?.changed) writeConfig(cfg);
    }
  }
  if (!uninstall) copyEmit(o.emitBuilt, dest);
  let backup = null;
  if (changed) {
    // A user's own settings file gets a one-time backup; a repo's file is already in git.
    if (user && text !== null) backup = backupOnce(settingsFile, now);
    writeAtomic(settingsFile, serialize(after, text));
  }
  if (uninstall && !user && existsSync(dest)) {
    // A leftover repo copy would make the user-level hook step aside (FR-004) and lose every event.
    unlinkSync(dest);
    try {
      rmdirSync(dirname(dest));
    } catch {
      // folder holds other files
    }
  }
  if (backup) say(`backup of the original: ${backup}`);
  say(changed ? (uninstall ? 'hooks removed' : 'hooks installed') : 'nothing to change');
  return { lines, changed, settingsFile, backup };
}

