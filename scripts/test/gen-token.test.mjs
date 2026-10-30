import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { genToken } from '../gen-token.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'gen-token.mjs');
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;

describe('gen-token', () => {
  it('returns 43-character base64url (32 bytes, no padding)', () => {
    const t = genToken();
    expect(t).toMatch(BASE64URL_43);
    expect(Buffer.from(t, 'base64url')).toHaveLength(32);
  });

  it('1000 tokens are all unique and well-formed', () => {
    const tokens = Array.from({ length: 1000 }, genToken);
    expect(tokens.every((t) => BASE64URL_43.test(t))).toBe(true);
    expect(new Set(tokens).size).toBe(1000);
  });

  it('CLI prints exactly one token line and exits 0', () => {
    const outs = Array.from({ length: 5 }, () =>
      spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }),
    );
    for (const r of outs) {
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
      expect(r.stdout).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
    }
    expect(new Set(outs.map((r) => r.stdout)).size).toBe(5);
  });
});
