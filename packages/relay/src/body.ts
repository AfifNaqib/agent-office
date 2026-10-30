// Reads a request body with a hard byte cap, without trusting Content-Length.
export type BodyResult = { ok: true; text: string } | { ok: false; reason: 'too_large' | 'bad_encoding' };

export async function readCapped(req: Request, max: number): Promise<BodyResult> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > max) return { ok: false, reason: 'too_large' };
  if (!req.body) return { ok: true, text: '' };
  const reader = req.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: 'too_large' };
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(all) };
  } catch {
    return { ok: false, reason: 'bad_encoding' };
  }
}
