// Bounded read of a small file the emitter does not control (token file, config.json).
// Untrusted from the hook's point of view: a FIFO would block the open, /dev/zero
// (or a symlink to it) would never end. So: open non-blocking, fstat the open
// descriptor (follows symlinks), require a regular file under the limit, then read
// at most that many bytes. Never throws, never blocks.
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

/** The file's text, or undefined for anything missing, unreadable, not a regular file or >= `limitBytes`. */
export function readSmallFile(file: string, limitBytes: number): string | undefined {
  let fd: number | undefined;
  try {
    // O_NONBLOCK is undefined on Windows; opening a FIFO there is not possible by path anyway.
    fd = openSync(file, constants.O_RDONLY | ((constants.O_NONBLOCK as number | undefined) ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile() || st.size >= limitBytes) return undefined;
    const buf = Buffer.alloc(limitBytes);
    let len = 0;
    while (len < buf.length) {
      const n = readSync(fd, buf, len, buf.length - len, null);
      if (n === 0) break;
      len += n;
    }
    // Grew past the limit between fstat and read.
    return len >= limitBytes ? undefined : buf.toString('utf8', 0, len);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // nothing to do
      }
    }
  }
}
