// B-07: the bridge also reads `port` from <data dir>/config.json, so the emit
// script must too, or a non-default port silently loses every event.
//
// Strict on purpose: a regular file under 64 KB (the bridge's own limit), a JSON
// object, `port` an integer from 1024 to 65535 (the bridge's schema). Anything else
// returns undefined and the caller falls back to the default port. Never throws.
import { readSmallFile } from './smallfile.js';

export const CONFIG_FILE = 'config.json';
export const MAX_CONFIG_FILE_BYTES = 64 * 1024;
export const MIN_CONFIG_PORT = 1024;
export const MAX_PORT = 65535;

export function readConfigPort(file: string): number | undefined {
  const text = readSmallFile(file, MAX_CONFIG_FILE_BYTES);
  if (text === undefined) return undefined;
  try {
    const json = JSON.parse(text) as unknown;
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return undefined;
    const port = (json as Record<string, unknown>).port;
    return typeof port === 'number' && Number.isInteger(port) && port >= MIN_CONFIG_PORT && port <= MAX_PORT ? port : undefined;
  } catch {
    return undefined;
  }
}
