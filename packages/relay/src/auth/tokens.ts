// Bearer token checks for /ingest (and later /bridge). Constant time: both sides
// are hashed to fixed-length SHA-256 digests and compared with a full XOR loop,
// so neither the content nor the length of the token leaks through timing.

/** gen-token makes 43 chars; anything shorter than this is treated as not configured. */
export const MIN_TOKEN_LENGTH = 32;

export function tokenConfigured(expected: string | undefined): expected is string {
  return typeof expected === 'string' && expected.length >= MIN_TOKEN_LENGTH;
}

const BEARER = /^Bearer +(\S+) *$/i;

/** The token from "Authorization: Bearer <token>", or null. */
export function bearerToken(header: string | undefined | null): string | null {
  if (!header) return null;
  return BEARER.exec(header)?.[1] ?? null;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

export async function tokensEqual(provided: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(provided), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** True only when the header carries exactly the expected bearer token. */
export async function bearerMatches(header: string | undefined | null, expected: string): Promise<boolean> {
  const token = bearerToken(header);
  // Still hash something on a missing token, so the timing of "absent" and "wrong" match.
  return tokensEqual(token ?? '', expected).then((same) => same && token !== null);
}
