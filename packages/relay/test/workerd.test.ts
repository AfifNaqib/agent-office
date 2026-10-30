// V1-01 against the real Workers runtime: `wrangler dev` (local workerd + the
// SQLite Durable Object), no Cloudflare account and no network needed. Checks the
// wiring plain-Node tests cannot: the entry module's exports, the DO RPC call,
// DO SQLite (migrations, UPSERT ... RETURNING, foreign keys), the retention alarm
// being scheduled, and the bundle (core aliased from source).
// Opt out with AGENT_OFFICE_SKIP_WORKERD=1 (for machines where workerd cannot run).
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { OfficeEvent } from '@agent-office/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIMITS, WINDOW_MS } from '../src/ratelimit.js';
import { AUD, TEAM, TOKEN, accessJwt, makeEvent } from './helpers.js';
import { relayDir, skipWorkerd, startWrangler, type Wrangler } from './workerdRig.js';

describe.skipIf(skipWorkerd)('V1-01 on workerd (wrangler dev, local)', () => {
  let w: Wrangler | undefined;
  let base = '';
  let persist = '';

  beforeAll(async () => {
    w = await startWrangler([], { INGEST_TOKEN: TOKEN, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD });
    base = w.base;
    persist = w.persist;
  }, 60_000);

  afterAll(async () => {
    await w?.dispose();
  }, 15_000);

  const post = (e: unknown, auth: string | null = `Bearer ${TOKEN}`): Promise<Response> =>
    fetch(`${base}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth === null ? {} : { authorization: auth }) },
      body: JSON.stringify(e),
    });

  it('V1-02: protected paths need the Access JWT (no network: these fail before the certs fetch); CSP; no CORS', async () => {
    const res = await fetch(`${base}/api/health`, { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const h = 'cf-access-jwt-assertion';
    expect((await fetch(`${base}/api/health`, { headers: { [h]: 'garbage' } })).status).toBe(401);
    const real = await accessJwt({ now: Date.now() });
    const [, payload] = real.split('.');
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${payload}.`;
    const hs = `${Buffer.from('{"alg":"HS256","kid":"kid-current"}').toString('base64url')}.${payload}.AAAA`;
    for (const jwt of [none, hs]) expect((await fetch(`${base}/api/health`, { headers: { [h]: jwt } })).status).toBe(401);
    for (const p of ['/ingestx', '/%69ngest', '/INGEST', '/ingest/']) {
      expect((await fetch(`${base}${p}`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(401);
    }
    expect((await fetch(`${base}/ingest`)).status).toBe(405);
  });

  it('V1-05: run_worker_first: the web build (/, /assets/*, /index.html) is never served without the JWT', async () => {
    const js = readdirSync(join(relayDir, '..', 'web', 'dist', 'assets')).find((f) => f.endsWith('.js'));
    expect(js).toBeDefined();
    for (const p of ['/', `/assets/${js}`, '/index.html', '/assets/']) {
      const res = await fetch(`${base}${p}`, { redirect: 'manual' });
      expect(res.status, p).toBe(401);
      expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    }
  });

  it('401 without the header (also for session.start), 400, 413, then 204 + dedupe', async () => {
    expect((await post(makeEvent(1, { kind: 'session.start', tool: undefined }), null)).status).toBe(401);
    expect((await post(makeEvent(1), 'Bearer wrong')).status).toBe(401);
    expect((await post({ ...makeEvent(2), kind: 'nope' })).status).toBe(400);
    expect((await post({ ...makeEvent(2), text: 'a'.repeat(70 * 1024) })).status).toBe(413);
    const secret = `ghp_${'Zy9Xw8Vu7T'.repeat(4)}`;
    expect((await post({ ...makeEvent(3, { source: 'local', text: `token ${secret}` }), receivedAt: 1 })).status).toBe(204);
    expect((await post(makeEvent(3))).status).toBe(204);
    expect((await post(makeEvent(4))).status).toBe(204);
  });

  // M-1 repro: a late event emitted before the session.end must not revive the session.
  const ENDED = '0a1b2c3d-0000-4000-8000-00000000e1d0';
  const REVIVED = '0a1b2c3d-0000-4000-8000-00000000a11e';
  it('M-1: tool.end emitted 500 ms before session.end keeps it ended; 500 ms after revives it', async () => {
    const T = Date.now();
    const end = { kind: 'session.end' as const, tool: undefined, emittedAt: T };
    expect((await post(makeEvent(500, { ...end, sessionId: ENDED }))).status).toBe(204);
    expect((await post(makeEvent(501, { kind: 'tool.end', sessionId: ENDED, emittedAt: T - 500 }))).status).toBe(204);
    expect((await post(makeEvent(502, { ...end, sessionId: REVIVED }))).status).toBe(204);
    expect((await post(makeEvent(503, { kind: 'tool.end', sessionId: REVIVED, emittedAt: T + 500 }))).status).toBe(204);
  });

  it('429 after the per-minute budget (counter kept in DO SQLite)', async () => {
    // Fixed one-minute windows on the relay clock (same machine). The loop can cross
    // a minute boundary, so accepted events are counted per wall-clock window.
    const perWindow = new Map<number, number>();
    let refusedIn = -1;
    for (let i = 0; i < 2 * LIMITS.ingest + 10 && refusedIn < 0; i++) {
      const win = Math.floor(Date.now() / WINDOW_MS);
      const res = await post(makeEvent(1000 + i));
      if (res.status === 429) {
        refusedIn = win;
        expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
      } else {
        expect(res.status).toBe(204);
        perWindow.set(win, (perWindow.get(win) ?? 0) + 1);
      }
    }
    expect(refusedIn).toBeGreaterThan(0);
    // Earlier tests may have used 7 authed hits of this window; +-2 for a request in flight at a boundary.
    const accepted = perWindow.get(refusedIn) ?? 0;
    expect(accepted).toBeGreaterThanOrEqual(LIMITS.ingest - 9);
    expect(accepted).toBeLessThanOrEqual(LIMITS.ingest + 2);
  }, 90_000);

  it('the DO stored only clean cloud events, the session rows (M-1), and scheduled the retention alarm', async () => {
    await w?.stop();
    const dir = join(persist, 'v3', 'do', 'agent-office-OfficeHub');
    const file = readdirSync(dir).find((f) => /^[0-9a-f]{64}\.sqlite$/.test(f));
    expect(file).toBeDefined();
    const db = new DatabaseSync(join(dir, file ?? ''));
    db.prepare('SELECT 1').get();
    const events = db.prepare('SELECT seq, id, session_key, received_at, payload_json FROM events ORDER BY seq').all() as {
      seq: number;
      id: string;
      session_key: string;
      received_at: number;
      payload_json: string;
    }[];
    expect(events.slice(0, 2).map((e) => e.id)).toEqual([makeEvent(3).id, makeEvent(4).id]);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    const first = JSON.parse(events[0]?.payload_json ?? '{}') as OfficeEvent;
    expect(first.source).toBe('cloud');
    expect(first.receivedAt).toBe(events[0]?.received_at);
    expect(first.receivedAt).toBeGreaterThan(Date.now() - 120_000);
    expect(events[0]?.payload_json).not.toContain('Zy9Xw8Vu7T');
    expect(db.prepare('SELECT session_key, source, status FROM sessions ORDER BY session_key').all()).toEqual([
      { session_key: `cloud:${REVIVED}`, source: 'cloud', status: 'live' },
      { session_key: `cloud:${ENDED}`, source: 'cloud', status: 'ended' },
      { session_key: `cloud:${makeEvent(1).sessionId}`, source: 'cloud', status: 'live' },
    ]);
    const ended = db.prepare('SELECT ended_at FROM sessions WHERE session_key = ?').get(`cloud:${ENDED}`) as { ended_at: number };
    expect(typeof ended.ended_at).toBe('number');
    // workerd internal: _cf_METADATA key 1 holds the alarm time in ns (seen with workerd 2026-10-19).
    // Not an API: if a workerd upgrade moves it, skip this check (the handler is unit-tested in hub.test.ts).
    const hasMeta = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = '_cf_METADATA'").get() !== undefined;
    const meta = hasMeta ? db.prepare('SELECT value FROM _cf_METADATA WHERE key = 1') : undefined;
    meta?.setReadBigInts(true);
    const alarmNs = (meta?.get() as { value?: unknown } | undefined)?.value;
    if (typeof alarmNs !== 'bigint') {
      console.warn('workerd.test: _cf_METADATA alarm row not found (workerd internals changed?); alarm-time check skipped');
    } else {
      const alarmMs = Number(alarmNs / 1_000_000n);
      expect(alarmMs).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
      expect(alarmMs).toBeLessThan(Date.now() + 25 * 60 * 60 * 1000);
    }
    db.close();
  });
});
