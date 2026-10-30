// "Was this file run directly?" for ESM scripts (BUG-05).
//
// Comparing resolve(process.argv[1]) with fileURLToPath(import.meta.url) fails
// when the script is reached through a symlink or a Windows junction (Node
// resolves the module URL to the real path, argv[1] keeps the link), or when the
// drive letter / folder casing differs on Windows. The script then silently did
// nothing. Both sides are now resolved with realpath, and compared
// case-insensitively on win32.

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function real(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

/**
 * True when the module at `metaUrl` is the entry script.
 * @param {string} metaUrl import.meta.url of the calling module
 * @param {string | undefined} [argv1] defaults to process.argv[1]
 * @param {NodeJS.Platform} [platform] defaults to process.platform
 */
export function isMain(metaUrl, argv1 = process.argv[1], platform = process.platform) {
  if (!argv1) return false;
  const a = real(resolve(argv1));
  const b = real(fileURLToPath(metaUrl));
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
