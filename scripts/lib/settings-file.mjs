// Reading, backing up and atomically writing a Claude settings.json (or any small JSON file we own a piece of).
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;

export class SettingsError extends Error {
  name = 'SettingsError';
}

/** Text of a regular file under `maxBytes`, null when it does not exist. Never blocks on a FIFO. Throws SettingsError otherwise. */
export function readTextFile(file, maxBytes = MAX_SETTINGS_BYTES) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) throw new SettingsError(`${file} is not a regular file under ${Math.round(maxBytes / 1024)} KB; nothing was changed`);
    const buf = Buffer.alloc(st.size);
    let len = 0;
    while (len < buf.length) {
      const n = readSync(fd, buf, len, buf.length - len, null);
      if (n === 0) break;
      len += n;
    }
    return buf.toString('utf8', 0, len);
  } catch (err) {
    if (err instanceof SettingsError) throw err;
    if (err?.code === 'ENOENT') return null;
    throw new SettingsError(`cannot read ${file} (${err?.code ?? 'error'}); nothing was changed`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Parse a JSON object from `text`. A leading BOM (PowerShell 5 writes one) is ignored. Throws SettingsError, never echoing the content. */
export function parseJsonObject(text, label) {
  try {
    const v = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw new SettingsError(`${label} is not a valid JSON object; fix it by hand, nothing was changed`);
  }
}

/** `{ settings, text }` of an existing file, or `{ settings: {}, text: null }` when missing. */
export function readSettings(file) {
  const text = readTextFile(file);
  if (text === null) return { settings: {}, text: null };
  // An empty or whitespace-only file counts as {}; the original text is kept for the backup and BOM rule.
  return { settings: text.trim() === '' ? {} : parseJsonObject(text, file), text };
}

/** Same indentation, line ending and BOM (kept only if the old file had one) as the file it replaces (2 spaces, LF, no BOM for a new file). */
export function serialize(value, previousText) {
  const indent = previousText?.match(/^\s*\{\s*\r?\n([ \t]+)"/)?.[1] ?? '  ';
  const out = `${JSON.stringify(value, null, indent)}\n`;
  const body = previousText?.includes('\r\n') ? out.replace(/\n/g, '\r\n') : out;
  return previousText?.charCodeAt(0) === 0xfeff ? `\uFEFF${body}` : body;
}

const pad = (n) => String(n).padStart(2, '0');
/** 20261024T101500Z: no colons, so it is a legal Windows file name. */
export function stamp(now) {
  const d = new Date(now);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/**
 * Copy `file` to `<name>.agent-office.<timestamp>.bak` the FIRST time only: when any such backup
 * already exists, nothing is copied (the oldest copy is the real original). Never overwrites.
 * Returns the backup path, or null when none was made.
 */
export function backupOnce(file, now = Date.now()) {
  if (!existsSync(file)) return null;
  const dir = dirname(file);
  const prefix = `${basename(file)}.agent-office.`;
  if (readdirSync(dir).some((f) => f.startsWith(prefix) && f.endsWith('.bak'))) return null;
  const dest = join(dir, `${prefix}${stamp(now)}.bak`);
  copyFileSync(file, dest, constants.COPYFILE_EXCL);
  return dest;
}

/** Write `text` to `file` through a temp file in the same folder and a rename, so a crash never leaves half a file. Follows a symlinked target. */
export function writeAtomic(file, text) {
  let target = file;
  let mode;
  if (existsSync(file)) {
    target = realpathSync(file);
    mode = statSync(target).mode & 0o777;
  }
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.agent-office-tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, { flag: 'wx' });
    if (mode !== undefined) {
      try {
        chmodSync(tmp, mode);
      } catch {
        // Windows: modes are not meaningful.
      }
    }
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // temp file never created
    }
    throw err;
  }
}
