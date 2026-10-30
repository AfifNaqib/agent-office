// POST /ingest (plan §10, FR-017, A3.2): cloud hook events.
// Order: token configured (503) -> Bearer INGEST_TOKEN, constant time (401) ->
// body cap 64 KB (413) -> JSON content type (400) -> JSON -> client receivedAt
// dropped, source forced to 'cloud' -> OfficeEvent schema (400) -> core second
// redaction pass -> receivedAt from the relay clock -> DO: rate limit (429),
// dedupe by id, store -> 204 (also for a duplicate).
//
// A3.6 D2: there is no exception for a header-less session.start. A rejected
// request is logged as count + kind only (never the body).
import { MAX_EVENT_BYTES } from '@agent-office/core';
import { Hono, type Context } from 'hono';
import { bearerMatches, tokenConfigured } from '../auth/tokens.js';
import { readCapped, type BodyResult } from '../body.js';
import type { HubApi, RelayBindings, RelayEnv } from '../types.js';
import { errorBody } from '../types.js';
import { idPrefix, type Logger } from '../log.js';
import { knownKind, prepareEvent } from '../prepare.js';

const JSON_TYPE = /^application\/json\s*(;.*)?$/i;
const ROUTE = 'ingest';

export interface IngestDeps<B extends RelayBindings> {
  readonly hub: (env: B) => HubApi;
  readonly now: () => number;
  readonly log: Logger;
}

/** The event kind of a rejected body, only if it is one of the known kinds. For logs. */
export function kindForLog(body: BodyResult): string {
  if (!body.ok) return '-';
  try {
    return knownKind(JSON.parse(body.text));
  } catch {
    return '-';
  }
}

type Status = 400 | 401 | 413 | 429 | 500 | 503;

export function ingestRoutes<B extends RelayBindings>(deps: IngestDeps<B>): Hono<RelayEnv<B>> {
  const app = new Hono<RelayEnv<B>>();

  const fail = (c: Context<RelayEnv<B>>, status: Status, code: string, message: string, kind = '-'): Response => {
    deps.log({ route: ROUTE, status, kind });
    return c.json(errorBody(code, message), status);
  };

  app.post('/ingest', async (c) => {
    const expected = c.env.INGEST_TOKEN;
    if (!tokenConfigured(expected)) return fail(c, 503, 'not_configured', 'Relay is not configured');
    const authed = await bearerMatches(c.req.header('authorization'), expected);
    const body = await readCapped(c.req.raw, MAX_EVENT_BYTES);
    if (!authed) return fail(c, 401, 'unauthorized', 'Missing or invalid token', kindForLog(body));
    if (!body.ok) {
      return body.reason === 'too_large'
        ? fail(c, 413, 'too_large', 'Event body too large')
        : fail(c, 400, 'invalid_json', 'Body is not valid UTF-8');
    }
    if (!JSON_TYPE.test(c.req.header('content-type') ?? '')) {
      return fail(c, 400, 'bad_content_type', 'Content-Type must be application/json');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(body.text);
    } catch {
      return fail(c, 400, 'invalid_json', 'Body is not valid JSON');
    }
    const prepared = prepareEvent(raw, 'cloud', deps.now());
    if (!prepared.ok) return fail(c, 400, prepared.code, prepared.message, prepared.kind);
    const event = prepared.event;
    const kind = event.kind;

    let result;
    try {
      result = await deps.hub(c.env).ingest(event);
    } catch {
      return fail(c, 500, 'store_failed', 'Could not store the event', kind);
    }
    switch (result.status) {
      case 'stored':
      case 'duplicate':
        deps.log({ route: ROUTE, status: result.status === 'stored' ? 204 : 'duplicate', kind, id: idPrefix(event.id) });
        return c.body(null, 204);
      case 'rate_limited':
        c.header('Retry-After', String(result.retryAfterSec));
        return fail(c, 429, 'rate_limited', 'Too many events', kind);
      case 'invalid':
        return fail(c, 400, 'invalid_event', 'Event rejected by the store', kind);
    }
  });

  return app;
}
