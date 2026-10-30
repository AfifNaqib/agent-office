// The one place a local/ingest token is generated: 32 bytes from the OS CSPRNG,
// base64url, no padding (always 43 characters). No CLI branch on purpose: the
// bridge and the setup script bundle/import this file, and a bundled CLI branch
// once printed a stray token on every bridge start (B-08).
import { randomBytes } from 'node:crypto';

export const TOKEN_BYTES = 32;

export function genToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}
