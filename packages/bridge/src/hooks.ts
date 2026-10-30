// POST /hooks/event (plan §10): token -> size cap -> JSON -> OfficeEvent schema ->
// receivedAt from the bridge's own clock -> second redaction pass -> dedupe by id ->
// store -> fan-out. 204 on success and on a duplicate id. The second pass is core's
// cleanEvent (shared with the relay).
import { bodyLimit } from 'hono/body-limit';
import { Hono } from 'hono';
import { MAX_EVENT_BYTES, OfficeEventSchema, cleanEvent } from '@agent-office/core';
import type { Logger } from './log.js';
import { deny, requireToken, type BridgeEnv } from './security.js';
import type { EventStore, StoredEvent } from './store.js';

const JSON_TYPE = /^application\/json\s*(;.*)?$/i;
export interface HooksDeps {
  readonly store: EventStore;
  readonly getToken: () => string;
  readonly now: () => number;
  readonly logger: Logger;
  readonly onStored: (s: StoredEvent) => void;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function hooksRoutes(deps: HooksDeps): Hono<BridgeEnv> {
  const app = new Hono<BridgeEnv>();
  app.post(
    '/hooks/event',
    requireToken(deps.getToken),
    bodyLimit({
      maxSize: MAX_EVENT_BYTES,
      onError: (c) => {
        c.header('Connection', 'close');
        deps.logger.event('-', '-', '413');
        return deny(c, 413, 'too_large', 'Event body too large');
      },
    }),
    async (c) => {
      if (!JSON_TYPE.test(c.req.header('content-type') ?? '')) {
        deps.logger.event('-', '-', '400');
        return deny(c, 400, 'bad_content_type', 'Content-Type must be application/json');
      }
      let body: unknown;
      try {
        body = JSON.parse(await c.req.text());
      } catch {
        deps.logger.event('-', '-', '400');
        return deny(c, 400, 'invalid_json', 'Body is not valid JSON');
      }
      if (!isPlainObject(body)) {
        deps.logger.event('-', '-', '400');
        return deny(c, 400, 'invalid_event', 'Body must be a JSON object');
      }
      // A client-supplied receivedAt is ignored, whatever it holds (A1.4 / V1 clamp relies on this).
      const rest = { ...body };
      delete rest.receivedAt;
      const parsed = OfficeEventSchema.safeParse(rest);
      if (!parsed.success) {
        deps.logger.event('-', '-', '400');
        return deny(c, 400, 'invalid_event', `Event failed validation at: ${[...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)'))].slice(0, 5).join(', ')}`);
      }
      const cleaned = OfficeEventSchema.safeParse({ ...cleanEvent(parsed.data), receivedAt: deps.now() });
      if (!cleaned.success) {
        deps.logger.event(parsed.data.kind, parsed.data.id, '400');
        return deny(c, 400, 'invalid_event', 'Event failed validation after cleaning');
      }
      const event = cleaned.data;
      let result;
      try {
        result = await deps.store.add(event);
      } catch {
        deps.logger.event(event.kind, event.id, '500');
        return deny(c, 500, 'store_failed', 'Could not store the event');
      }
      if (result.status === 'duplicate') {
        deps.logger.event(event.kind, event.id, 'duplicate');
        return c.body(null, 204);
      }
      deps.onStored(result.stored);
      deps.logger.event(event.kind, event.id, '204');
      return c.body(null, 204);
    },
  );
  return app;
}
