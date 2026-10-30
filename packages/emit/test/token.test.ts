// B-04: the token file is read through fstat of an open, non-blocking descriptor.
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { MAX_TOKEN_FILE_BYTES, readToken } from '../src/token.js';
import { BUILT, LOCAL_HEADER_VALUE, buildEmit, dataDirWithToken, fixture, mockServer, runEmit, tempDir } from './helpers.js';

const posix = process.platform !== 'win32';

describe('readToken', () => {
  it('reads a small regular file, and follows a symlink to one', () => {
    const dir = tempDir();
    const file = join(dir, 'local-token');
    writeFileSync(file, `${LOCAL_HEADER_VALUE}\n`);
    expect(readToken(file)).toBe(`${LOCAL_HEADER_VALUE}\n`);
    if (posix) {
      symlinkSync(file, join(dir, 'link'));
      expect(readToken(join(dir, 'link'))).toBe(`${LOCAL_HEADER_VALUE}\n`);
    }
  });

  it('missing file, directory and empty path give undefined', () => {
    const dir = tempDir();
    expect(readToken(join(dir, 'nope'))).toBeUndefined();
    mkdirSync(join(dir, 'd'));
    expect(readToken(join(dir, 'd'))).toBeUndefined();
    expect(readToken('')).toBeUndefined();
  });

  it('rejects files of 1 KB or more, accepts 1023 bytes', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'big'), 'a'.repeat(MAX_TOKEN_FILE_BYTES));
    writeFileSync(join(dir, 'huge'), 'a'.repeat(5_000_000));
    writeFileSync(join(dir, 'ok'), 'a'.repeat(MAX_TOKEN_FILE_BYTES - 1));
    expect(readToken(join(dir, 'big'))).toBeUndefined();
    expect(readToken(join(dir, 'huge'))).toBeUndefined();
    expect(readToken(join(dir, 'ok'))).toHaveLength(MAX_TOKEN_FILE_BYTES - 1);
  });

  it.runIf(posix)('a FIFO, a device and a symlink to /dev/zero return undefined at once', () => {
    const dir = tempDir();
    execFileSync('mkfifo', [join(dir, 'fifo')]);
    symlinkSync('/dev/zero', join(dir, 'zero'));
    const t0 = Date.now();
    expect(readToken(join(dir, 'fifo'))).toBeUndefined();
    expect(readToken(join(dir, 'zero'))).toBeUndefined();
    expect(readToken('/dev/zero')).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe.runIf(posix)('the built hook with a hostile token file', () => {
  beforeAll(() => {
    buildEmit();
  }, 60_000);

  it.each(['fifo', 'zero-symlink'])('%s: exits 0 within ~6 s (in practice at once), sends nothing, prints nothing', async (kind) => {
    const home = dataDirWithToken(null);
    if (kind === 'fifo') execFileSync('mkfifo', [join(home, 'local-token')]);
    else symlinkSync('/dev/zero', join(home, 'local-token'));
    const m = await mockServer();
    try {
      const r = await runEmit(fixture('pc2', '001-SessionStart-exec.json'), { AGENT_OFFICE_HOME: home, AGENT_OFFICE_BRIDGE_PORT: String(m.port) }, BUILT);
      expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(r.ms).toBeLessThan(6000);
      expect(m.requests).toHaveLength(0);
    } finally {
      await m.close();
    }
  }, 20_000);
});
