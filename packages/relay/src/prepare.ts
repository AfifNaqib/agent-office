// The one validation + cleaning path for every event the relay accepts (POST /ingest
// from cloud hooks, and since V1-04 the PC bridge's /bridge socket):
// plain JSON object -> client receivedAt dropped -> source forced (the channel decides:
// 'cloud' for /ingest, 'local' for /bridge, never the sender) -> strict OfficeEvent
// schema -> core second redaction pass (cleanEvent) -> receivedAt from the relay clock.
import { EVENT_KINDS, OfficeEventSchema, cleanEvent, type OfficeEvent } from '@agent-office/core';

const KINDS: ReadonlySet<string> = new Set(EVENT_KINDS);

export type Prepared =
  | { readonly ok: true; readonly event: OfficeEvent }
  | { readonly ok: false; readonly code: 'invalid_event'; readonly message: string; readonly kind: string };

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The event kind of a raw value, only if it is one of the known kinds (for logs), else '-'. */
export function knownKind(v: unknown): string {
  return isPlainObject(v) && typeof v.kind === 'string' && KINDS.has(v.kind) ? v.kind : '-';
}

export function prepareEvent(raw: unknown, source: OfficeEvent['source'], now: number): Prepared {
  if (!isPlainObject(raw)) return { ok: false, code: 'invalid_event', message: 'Body must be a JSON object', kind: '-' };
  const rest: Record<string, unknown> = { ...raw, source };
  delete rest.receivedAt;
  const parsed = OfficeEventSchema.safeParse(rest);
  if (!parsed.success) {
    const paths = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)'))].slice(0, 5);
    return { ok: false, code: 'invalid_event', message: `Event failed validation at: ${paths.join(', ')}`, kind: '-' };
  }
  const kind = parsed.data.kind;
  const cleaned = OfficeEventSchema.safeParse({ ...cleanEvent(parsed.data), receivedAt: now });
  if (!cleaned.success) return { ok: false, code: 'invalid_event', message: 'Event failed validation after cleaning', kind };
  return { ok: true, event: cleaned.data };
}
