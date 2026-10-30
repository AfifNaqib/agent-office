// Event id (FR-005, §7): sha256(source + rawPayload), lowercase hex.
// Uses Web Crypto, which exists in Node >= 20, Workers and browsers.
import type { Source } from './schema.js';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Deterministic: the same (source, raw stdin text) always yields the same id. */
export async function fingerprint(source: Source, raw: string): Promise<string> {
  const data = new TextEncoder().encode(source + raw);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(digest));
}
