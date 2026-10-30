// Reads the local token file (B-04) through the bounded small-file reader.
import { readSmallFile } from './smallfile.js';

/** gen-token writes 44 bytes; anything from 1 KB up is not a token file. */
export const MAX_TOKEN_FILE_BYTES = 1024;

/** The file's text, or undefined for anything missing, unreadable, not a regular file or >= 1 KB. Never throws, never blocks. */
export function readToken(file: string): string | undefined {
  return readSmallFile(file, MAX_TOKEN_FILE_BYTES);
}
