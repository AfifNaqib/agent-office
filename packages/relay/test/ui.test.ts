// V1-03 under plain Node: HubCore history (paging, seq, boot, byte cap), the UI
// routes behind Access, the fan-out helpers with fake sockets, and a contract test
// that drives the web client (packages/web/src/live.ts) with the relay's history
// pages and socket messages.
import { DatabaseSync } from 'node:sqlite';
import type { OfficeEvent } from '@agent-office/core';
import { describe, expect, it } from 'vitest';
import * as web from '../../web/src/live.js';
import { HubCore, MAX_PAGE_BYTES, RETENTION_MS, utf8Length, type StoredEvent } from '../src/hubCore.js';
import { CLOCK_TOLERANCE_SEC } from '../src/auth/access.js';
import { securityHeaders } from '../src/auth/guard.js';
import {
  CLOSE_LOGIN_EXPIRED,
  CLOSE_REPLACED,
  CLOSE_SEND_FAILED,
  CLOSE_TOO_BIG,
  EXP_GRACE_MS,
  EXP_HEADER,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_UI_SOCKETS,
  PING_MESSAGE,
  PONG_MESSAGE,
  canAdmit,
  closeExpired,
  eventMessage,
  fanout,
  helloMessage,
  loginExpired,
  onClientMessage,
  parseExp,
  socketsToEvict,
  uiUpgradeRequest,
  type UiSocket,
} from '../src/uiSockets.js';
import { BASE, NOW0, accessJwt, makeEvent, sqliteStore, startRig, type Rig } from './helpers.js';

const H = 'cf-access-jwt-assertion';

function storeAt(core: HubCore, n: number, over: Partial<OfficeEvent> = {}, receivedAt = NOW0 + n): void {
  const r = core.ingest({ ...makeEvent(n, over), receivedAt }, 'ingest', NOW0);
  expect(r.status).toBe('stored');
}

describe('HubCore history (same shapes as the bridge)', () => {
  it('events(): seq order, after cursor, limit, hasMore, boot, lastSeq', () => {
    const core = new HubCore(sqliteStore());
    for (let i = 1; i <= 5; i++) storeAt(core, i, { sessionId: i % 2 ? 'odd' : 'even' });
    const p1 = core.events(0, 2);
    expect(p1.events.map((s) => s.seq)).toEqual([1, 2]);
    expect(p1.hasMore).toBe(true);
    expect(p1.lastSeq).toBe(5);
    expect(p1.boot).toBe(core.boot);
    const p2 = core.events(2, 10);
    expect(p2.events.map((s) => s.seq)).toEqual([3, 4, 5]);
    expect(p2.hasMore).toBe(false);
    expect(core.events(5, 10)).toEqual({ boot: core.boot, lastSeq: 5, events: [], hasMore: false });
    // Exactly `limit` left: no phantom next page.
    expect(core.events(3, 2).hasMore).toBe(false);
    expect(p2.events[0]?.event.id).toBe(makeEvent(3).id);
  });

  it('sessionEvents(): only that session; null for an unknown key', () => {
    const core = new HubCore(sqliteStore());
    for (let i = 1; i <= 5; i++) storeAt(core, i, { sessionId: i % 2 ? 'odd' : 'even' });
    const odd = core.sessionEvents('cloud:odd', 0, 10);
    expect(odd?.events.map((s) => s.seq)).toEqual([1, 3, 5]);
    expect(core.sessionEvents('cloud:odd', 1, 1)).toMatchObject({ events: [{ seq: 3 }], hasMore: true });
    expect(core.sessionEvents('cloud:nope', 0, 10)).toBeNull();
    expect(core.sessionEvents('local:odd', 0, 10)).toBeNull();
  });

  it('sessionList(): bridge SessionEntry fields, newest activity first', () => {
    const core = new HubCore(sqliteStore());
    storeAt(core, 1, { sessionId: 'a' });
    storeAt(core, 2, { sessionId: 'b', repo: 'agent-office' });
    storeAt(core, 3, { sessionId: 'a' });
    storeAt(core, 4, { sessionId: 'a', kind: 'session.end', tool: undefined });
    const { sessions, boot, lastSeq } = core.sessionList();
    expect(boot).toBe(core.boot);
    expect(lastSeq).toBe(4);
    expect(sessions).toEqual([
      {
        key: 'cloud:a',
        source: 'cloud',
        sessionId: 'a',
        remoteSessionId: 'cse_01AbCdEfGhIjKlMnOpQrStUv',
        runId: null,
        repo: 'portfolio',
        startedAt: NOW0 + 1,
        lastEventAt: NOW0 + 4,
        endedAt: NOW0 + 4,
        eventCount: 3,
        lastSeq: 4,
      },
      expect.objectContaining({ key: 'cloud:b', repo: 'agent-office', eventCount: 1, lastSeq: 2, endedAt: null }),
    ]);
  });

  it('boot is made once and kept in SQLite (the DO restarting or waking from hibernation keeps it); a new store gets a new one', () => {
    const db = new DatabaseSync(':memory:');
    const first = new HubCore(sqliteStore(db), { newBoot: () => 'boot-1' });
    const again = new HubCore(sqliteStore(db), { newBoot: () => 'boot-2' });
    expect(first.boot).toBe('boot-1');
    expect(again.boot).toBe('boot-1');
    expect(new HubCore(sqliteStore()).boot).toMatch(/^[0-9a-f-]{36}$/);
    expect(new HubCore(sqliteStore()).boot).not.toBe(new HubCore(sqliteStore()).boot);
  });

  it('seq keeps growing after retention empties the table (no restart, same boot)', () => {
    const core = new HubCore(sqliteStore());
    storeAt(core, 1);
    storeAt(core, 2);
    expect(core.lastSeq()).toBe(2);
    core.retention(NOW0 + RETENTION_MS + 10);
    expect(core.events(0, 10).events).toEqual([]);
    // L-3: lastSeq comes from sqlite_sequence, so it does not fall back to 0 (a client
    // with lastSeq 2 would otherwise think the hub went backwards).
    expect(core.lastSeq()).toBe(2);
    expect(core.events(0, 10).lastSeq).toBe(2);
    expect(core.sessionList().lastSeq).toBe(2);
    storeAt(core, 3, {}, NOW0 + RETENTION_MS + 20);
    expect(core.events(0, 10).events.map((s) => s.seq)).toEqual([3]);
    expect(core.lastSeq()).toBe(3);
  });

  it('lastSeq is 0 before the first event and falls back to MAX(seq) when sqlite_sequence cannot be read', () => {
    const core = new HubCore(sqliteStore());
    expect(core.lastSeq()).toBe(0);
    storeAt(core, 1);
    const sql = (core as unknown as { sql: { exec: (q: string, ...b: unknown[]) => unknown[] } }).sql;
    const realExec = sql.exec.bind(sql);
    sql.exec = (q: string, ...b: unknown[]) => {
      if (q.includes('sqlite_sequence')) throw new Error('not authorized');
      return realExec(q, ...b);
    };
    expect(core.lastSeq()).toBe(1);
  });

  it('utf8Length equals TextEncoder byte length (ASCII, 2/3/4-byte, lone surrogates)', () => {
    for (const t of ['', 'abc', 'é', '日本語', '😀', 'a😀b', '\ud800', '\udc00x', 'x\ud800', '\u07ff\u0800', JSON.stringify({ t: '工具 "q" \n' })]) {
      expect(utf8Length(t)).toBe(new TextEncoder().encode(t).byteLength);
    }
  });

  it('L-1: the page cap counts UTF-8 bytes: 5000 CJK-heavy events stay within MAX_PAGE_BYTES', () => {
    const core = new HubCore(sqliteStore());
    const cjk = '日本語の作業記録'.repeat(50); // 400 chars, 1200 bytes
    const sql = (core as unknown as { sql: { exec: (q: string, ...b: (string | number)[]) => unknown; transaction: <T>(fn: () => T) => T } }).sql;
    storeAt(core, 0); // the session row (events reference it)
    let chars = 0;
    let bytes = 0;
    sql.transaction(() => {
      for (let n = 1; n <= 5000; n++) {
        const e = makeEvent(n);
        const payload = JSON.stringify({ ...e, receivedAt: NOW0, text: `${cjk}${n}` });
        chars += payload.length;
        bytes += new TextEncoder().encode(payload).byteLength;
        sql.exec(
          'INSERT INTO events (id, session_key, emitted_at, received_at, kind, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
          e.id,
          `cloud:${e.sessionId}`,
          NOW0,
          NOW0,
          'tool.start',
          payload,
        );
      }
    });
    // The old character count would have sent all 5000 in one page (over 4 MiB of bytes).
    expect(chars).toBeLessThan(MAX_PAGE_BYTES);
    expect(bytes).toBeGreaterThan(MAX_PAGE_BYTES);
    const p = core.events(0, 5000);
    expect(p.hasMore).toBe(true);
    const pageBytes = p.events.reduce((sum, s) => sum + new TextEncoder().encode(JSON.stringify(s.event)).byteLength, 0);
    expect(pageBytes).toBeLessThanOrEqual(MAX_PAGE_BYTES);
    expect(p.events.length).toBeLessThan(5000);
    // The next page continues where this one stopped; together they hold all 5000.
    const q = core.events(p.events.at(-1)?.seq ?? 0, 5000);
    expect(q.hasMore).toBe(false);
    expect(p.events.length + q.events.length).toBe(5001);
  });

  it('a page stops at MAX_PAGE_BYTES of payload (hasMore), but always carries one event', () => {
    const core = new HubCore(sqliteStore());
    const big = 'x'.repeat(400);
    // Inserted straight into SQLite: real events are at most 64 KB, here each row is ~1.6 MB.
    const filler = (n: number): string => JSON.stringify({ ...makeEvent(n), receivedAt: NOW0, text: big.repeat(4000) });
    storeAt(core, 1);
    const sql = (core as unknown as { sql: { exec: (q: string, ...b: (string | number)[]) => unknown } }).sql;
    for (let n = 2; n <= 5; n++) {
      sql.exec(
        'INSERT INTO events (id, session_key, emitted_at, received_at, kind, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
        makeEvent(n).id,
        `cloud:${makeEvent(n).sessionId}`,
        NOW0,
        NOW0,
        'tool.start',
        filler(n),
      );
    }
    expect(filler(2).length).toBeGreaterThan(MAX_PAGE_BYTES / 3);
    const p = core.events(0, 5000);
    expect(p.events.map((s) => s.seq)).toEqual([1, 2, 3]);
    expect(p.hasMore).toBe(true);
    // A single row over the cap is still delivered alone.
    const q = core.events(3, 5000);
    expect(q.events.map((s) => s.seq)).toEqual([4, 5]);
  });

  it('events7d counts events received in the last 7 days', () => {
    const core = new HubCore(sqliteStore());
    storeAt(core, 1, {}, NOW0 - RETENTION_MS - 1);
    storeAt(core, 2, {}, NOW0);
    expect(core.events7d(NOW0)).toBe(1);
  });

  it('onStored fires after the commit, once per newly stored event, in seq order (never for duplicates or refusals)', () => {
    const r = startRig();
    const ev = (n: number): OfficeEvent => ({ ...makeEvent(n), receivedAt: NOW0 });
    r.core.ingest(ev(1), 'ingest', NOW0);
    r.core.ingest(ev(1), 'ingest', NOW0);
    r.core.ingest({ ...ev(2), kind: 'nope' }, 'ingest', NOW0);
    r.core.ingest(ev(3), 'ingest', NOW0);
    expect(r.pushed.map((s) => [s.seq, s.event.id])).toEqual([
      [1, ev(1).id],
      [2, ev(3).id],
    ]);
    expect(r.pushed[0]?.event).toEqual(r.core.events(0, 1).events[0]?.event);
  });

  it('a failing transaction pushes nothing', () => {
    const db = new DatabaseSync(':memory:');
    const pushed: StoredEvent[] = [];
    const store = sqliteStore(db);
    const core = new HubCore(store, { onStored: (s) => pushed.push(s) });
    db.exec('DROP TABLE events');
    expect(() => core.ingest({ ...makeEvent(1), receivedAt: NOW0 }, 'ingest', NOW0)).toThrow();
    expect(pushed).toEqual([]);
  });
});

async function jwtGet(r: Rig, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return r.fetch(path, { headers: { [H]: await accessJwt(), ...headers } });
}

describe('UI routes behind Access', () => {
  it('every UI route needs the JWT', async () => {
    const r = startRig();
    for (const p of ['/api/sessions', '/api/events', '/api/sessions/cloud:x/events', '/ws/ui']) {
      expect((await r.fetch(p)).status).toBe(401);
    }
    expect(r.upgrades).toEqual([]);
  });

  it('GET /api/events and /api/sessions/:key/events page like the bridge; bad query 400; unknown or malformed key 404', async () => {
    const r = startRig();
    for (let i = 1; i <= 3; i++) expect((await r.post(makeEvent(i))).status).toBe(204);
    const page = (await (await jwtGet(r, '/api/events?after=1&limit=1')).json()) as { boot: string; lastSeq: number; events: { seq: number }[]; hasMore: boolean };
    expect(page).toMatchObject({ boot: r.core.boot, lastSeq: 3, hasMore: true });
    expect(page.events.map((s) => s.seq)).toEqual([2]);
    const key = `cloud:${makeEvent(1).sessionId}`;
    const s = (await (await jwtGet(r, `/api/sessions/${key}/events`)).json()) as typeof page;
    expect(s.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    for (const q of ['?after=-1', '?after=1.5', '?limit=abc', '?after=9999999999999999']) {
      expect((await jwtGet(r, `/api/events${q}`)).status).toBe(400);
      expect((await jwtGet(r, `/api/sessions/${key}/events${q}`)).status).toBe(400);
    }
    for (const k of ['cloud:unknown', 'remote:abc', 'cloud:..', 'cloud:a%2Fb', 'nope']) {
      const res = await jwtGet(r, `/api/sessions/${k}/events`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Unknown session' } });
    }
    // limit is clamped to MAX_PAGE, not refused
    expect((await jwtGet(r, '/api/events?limit=99999')).status).toBe(200);
  });

  it('GET /api/sessions returns {boot, lastSeq, sessions}', async () => {
    const r = startRig();
    await r.post(makeEvent(1));
    const body = (await (await jwtGet(r, '/api/sessions')).json()) as { boot: string; lastSeq: number; sessions: { key: string }[] };
    expect(body.boot).toBe(r.core.boot);
    expect(body.lastSeq).toBe(1);
    expect(body.sessions.map((s) => s.key)).toEqual([`cloud:${makeEvent(1).sessionId}`]);
  });

  it('GET /ws/ui: needs an upgrade (426), passes the JWT exp (ms) to the DO', async () => {
    const r = startRig();
    const plain = await jwtGet(r, '/ws/ui');
    expect(plain.status).toBe(426);
    const jwt = await accessJwt({ expOffset: 600 });
    const res = await r.fetch('/ws/ui', { headers: { [H]: jwt, upgrade: 'websocket', origin: BASE } });
    expect(res.status).toBe(200); // the fake DO
    expect(r.upgrades).toHaveLength(1);
    expect(r.upgrades[0]?.expMs).toBe((Math.floor(NOW0 / 1000) + 600) * 1000);
  });

  it('L-2: 10 to 20 s past exp the guard (HTTP) and the socket rules agree; past 30 s both refuse', async () => {
    for (const offset of [-10, -15, -20]) {
      const r = startRig();
      const jwt = await accessJwt({ expOffset: offset });
      expect((await r.fetch('/api/events', { headers: { [H]: jwt } })).status).toBe(200);
      const res = await r.fetch('/ws/ui', { headers: { [H]: jwt, upgrade: 'websocket', origin: BASE } });
      expect(res.status).toBe(200); // handed to the (fake) DO
      const expMs = r.upgrades[0]?.expMs;
      expect(expMs).toBe((Math.floor(NOW0 / 1000) + offset) * 1000);
      expect(loginExpired(expMs, r.clock.now)).toBe(false);
    }
    const r = startRig();
    const old = await accessJwt({ expOffset: -31 });
    const res = await r.fetch('/api/events', { headers: { [H]: old } });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(loginExpired((Math.floor(NOW0 / 1000) - 31) * 1000, NOW0)).toBe(true);
  });

  it('a POST to a UI route is 404 with own Origin, 403 without (guard first)', async () => {
    const r = startRig();
    expect((await r.fetch('/api/events', { method: 'POST', headers: { [H]: await accessJwt(), origin: BASE } })).status).toBe(404);
    expect((await r.fetch('/api/events', { method: 'POST', headers: { [H]: await accessJwt() } })).status).toBe(403);
  });
});

describe('R-2: securityHeaders leaves a 101 untouched', () => {
  it('returns the very same Response object, no headers added', async () => {
    const { Hono } = await import('hono');
    // Node cannot build a 101 Response, so fake the status on a 200 one.
    const upgrade = new Response(null, { status: 200 });
    Object.defineProperty(upgrade, 'status', { value: 101 });
    const app = new Hono();
    app.use('*', securityHeaders());
    app.get('/ws/ui', () => upgrade);
    app.get('/x', (c) => c.text('ok'));
    const res = await app.fetch(new Request(`${BASE}/ws/ui`));
    expect(res).toBe(upgrade);
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect((await app.fetch(new Request(`${BASE}/x`))).headers.get('content-security-policy')).toContain("default-src 'self'");
  });
});

interface FakeSocket extends UiSocket {
  readonly sent: string[];
  closedWith: { code?: number; reason?: string } | null;
}

function fakeSocket(attachment: unknown, opts: { sendThrows?: boolean; closeThrows?: boolean } = {}): FakeSocket {
  const s: FakeSocket = {
    sent: [],
    closedWith: null,
    send: (m) => {
      if (opts.sendThrows) throw new Error('broken');
      s.sent.push(m);
    },
    close: (code, reason) => {
      if (opts.closeThrows) throw new Error('already closed');
      s.closedWith = { code, reason };
    },
    deserializeAttachment: () => attachment,
  };
  return s;
}

describe('fan-out helpers (fake sockets)', () => {
  const stored: StoredEvent = { seq: 7, event: makeEvent(7) };

  it('AC: two sockets each receive the event message; bridge /ws message shape', () => {
    const a = fakeSocket({ expMs: NOW0 + 1000 });
    const b = fakeSocket({ expMs: NOW0 + 1000 });
    const msg = eventMessage('boot-x', stored);
    expect(fanout([a, b], msg, NOW0)).toEqual({ sent: 2, closed: 0 });
    for (const s of [a, b]) expect(s.sent.map((m) => JSON.parse(m) as unknown)).toEqual([{ type: 'event', seq: 7, boot: 'boot-x', event: makeEvent(7) }]);
    expect(JSON.parse(helloMessage('boot-x', 7))).toEqual({ type: 'hello', boot: 'boot-x', lastSeq: 7, bridgeOnline: false });
    expect(JSON.parse(helloMessage('boot-x', 7, true))).toEqual({ type: 'hello', boot: 'boot-x', lastSeq: 7, bridgeOnline: true });
  });

  it('expired / missing / malformed login -> closed 4401, no send; a throwing send -> 1011; the others still get it', () => {
    const ok = fakeSocket({ expMs: NOW0 + 1 });
    const expired = fakeSocket({ expMs: NOW0 - EXP_GRACE_MS });
    const none = fakeSocket(null);
    const bad = fakeSocket({ expMs: 'later' });
    const throwsAttach = fakeSocket(undefined);
    throwsAttach.deserializeAttachment = () => {
      throw new Error('bad attachment');
    };
    const broken = fakeSocket({ expMs: NOW0 + 1 }, { sendThrows: true, closeThrows: true });
    const ok2 = fakeSocket({ expMs: NOW0 + 1 });
    const r = fanout([ok, expired, none, bad, throwsAttach, broken, ok2], 'm', NOW0);
    expect(r).toEqual({ sent: 2, closed: 5 });
    expect(ok.sent).toEqual(['m']);
    expect(ok2.sent).toEqual(['m']);
    for (const s of [expired, none, bad, throwsAttach]) {
      expect(s.sent).toEqual([]);
      expect(s.closedWith?.code).toBe(CLOSE_LOGIN_EXPIRED);
    }
    expect(broken.closedWith).toBeNull(); // close threw, swallowed
    expect(CLOSE_SEND_FAILED).toBe(1011);
  });

  it('closeExpired closes only expired sockets', () => {
    const live = fakeSocket({ expMs: NOW0 + 5 });
    const old = fakeSocket({ expMs: NOW0 - EXP_GRACE_MS - 5 });
    expect(closeExpired([live, old], NOW0)).toBe(1);
    expect(live.closedWith).toBeNull();
    expect(old.closedWith?.code).toBe(CLOSE_LOGIN_EXPIRED);
  });

  it('client messages: never interpreted; over 2 KB (UTF-8 bytes) -> 1009; expired login -> 4401', () => {
    const s = fakeSocket({ expMs: NOW0 + 5 });
    onClientMessage(s, JSON.stringify({ type: 'auth', token: 'x' }), NOW0);
    onClientMessage(s, 'a'.repeat(MAX_CLIENT_MESSAGE_BYTES), NOW0);
    expect(s.closedWith).toBeNull();
    expect(s.sent).toEqual([]);
    onClientMessage(s, 'é'.repeat(MAX_CLIENT_MESSAGE_BYTES / 2 + 1), NOW0);
    expect(s.closedWith?.code).toBe(CLOSE_TOO_BIG);
    const bin = fakeSocket({ expMs: NOW0 + 5 });
    onClientMessage(bin, new ArrayBuffer(MAX_CLIENT_MESSAGE_BYTES + 1), NOW0);
    expect(bin.closedWith?.code).toBe(CLOSE_TOO_BIG);
    const old = fakeSocket({ expMs: NOW0 - EXP_GRACE_MS });
    onClientMessage(old, 'hi', NOW0);
    expect(old.closedWith?.code).toBe(CLOSE_LOGIN_EXPIRED);
  });

  it('socket cap: 16', () => {
    expect(MAX_UI_SOCKETS).toBe(16);
    expect(canAdmit(15)).toBe(true);
    expect(canAdmit(16)).toBe(false);
  });

  it('L-2: a login stays valid until exp + the guard clock tolerance (30 s), in every path', () => {
    expect(EXP_GRACE_MS).toBe(CLOCK_TOLERANCE_SEC * 1000);
    const exp = NOW0;
    for (const past of [10_000, 20_000, EXP_GRACE_MS - 1]) {
      const now = exp + past;
      expect(loginExpired(exp, now)).toBe(false);
      const s = fakeSocket({ expMs: exp });
      expect(fanout([s], 'm', now)).toEqual({ sent: 1, closed: 0 });
      expect(closeExpired([s], now)).toBe(0);
      onClientMessage(s, 'hi', now);
      expect(s.closedWith).toBeNull();
    }
    expect(loginExpired(exp, exp + EXP_GRACE_MS)).toBe(true);
    expect(loginExpired(undefined, NOW0)).toBe(true);
    const late = fakeSocket({ expMs: exp });
    expect(fanout([late], 'm', exp + EXP_GRACE_MS)).toEqual({ sent: 0, closed: 1 });
    expect(late.closedWith?.code).toBe(CLOSE_LOGIN_EXPIRED);
  });

  it('N-1: socketsToEvict: none while there is room; at the cap expired first, then the oldest openedAt', () => {
    const live = (openedAt: number | undefined): FakeSocket => fakeSocket({ expMs: NOW0 + 60_000, openedAt });
    const fifteen = Array.from({ length: MAX_UI_SOCKETS - 1 }, (_, i) => live(NOW0 + i));
    expect(socketsToEvict(fifteen, NOW0)).toEqual([]);
    const full = Array.from({ length: MAX_UI_SOCKETS }, (_, i) => live(NOW0 + 100 - i)); // last is oldest
    expect(socketsToEvict(full, NOW0)).toEqual([full[MAX_UI_SOCKETS - 1]]);
    const expired = fakeSocket({ expMs: NOW0 - EXP_GRACE_MS, openedAt: NOW0 + 999 });
    const withExpired = [...full.slice(1), expired];
    expect(socketsToEvict(withExpired, NOW0)).toEqual([expired]);
    // A socket with no openedAt (unreadable attachment) counts as oldest.
    const unknown = live(undefined);
    expect(socketsToEvict([...full.slice(1), unknown], NOW0)).toEqual([unknown]);
    // Over the cap by more than one (should not happen): enough to leave one slot.
    const over = [...full, live(NOW0 - 5), live(NOW0 - 6)];
    expect(socketsToEvict(over, NOW0)).toEqual([over[MAX_UI_SOCKETS + 1], over[MAX_UI_SOCKETS], full[MAX_UI_SOCKETS - 1]]);
    expect(CLOSE_REPLACED).toBe(4000);
  });

  it('parseExp accepts positive integer ms only', () => {
    expect(parseExp('1700000000000')).toBe(1700000000000);
    for (const v of [null, '', '0', '-1', '1.5', '1e12', ' 12', '99999999999999999']) expect(parseExp(v)).toBeUndefined();
  });

  it('uiUpgradeRequest overwrites a client-sent exp header and keeps the upgrade headers', () => {
    const req = new Request(`${BASE}/ws/ui`, { headers: { upgrade: 'websocket', [EXP_HEADER]: '99999999999999', 'sec-websocket-key': 'k' } });
    const out = uiUpgradeRequest(req, 1234.9);
    expect(out.headers.get(EXP_HEADER)).toBe('1234');
    expect(out.headers.get('upgrade')).toBe('websocket');
    expect(out.headers.get('sec-websocket-key')).toBe('k');
    expect(out.url).toBe(`${BASE}/ws/ui`);
  });
});

describe('contract: packages/web live.ts against the relay history + fan-out', () => {
  it('history then live events arrive once each, in seq order; status goes live', async () => {
    const r = startRig();
    for (let i = 1; i <= 3; i++) await r.post(makeEvent(i));
    const jwt = await accessJwt();
    const got: string[] = [];
    const statuses: string[] = [];
    const sockets: { ui: UiSocket; client: web.MiniSocket }[] = [];
    let resets = 0;
    const sent: string[] = [];

    class FakeWs implements web.MiniSocket {
      onopen: (() => void) | null = null;
      onmessage: ((m: { data: unknown }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(readonly url: string) {
        // What the DO does on accept: attach the login, send hello.
        const ui = fakeSocket({ expMs: NOW0 + 3_600_000 });
        ui.send = (m) => {
          queueMicrotask(() => this.onmessage?.({ data: m }));
        };
        sockets.push({ ui, client: this });
        queueMicrotask(() => {
          this.onopen?.();
          ui.send(helloMessage(r.core.boot, r.core.lastSeq()));
        });
      }
      send(data: string): void {
        sent.push(data);
      }
      close(): void {
        this.onclose?.();
      }
    }

    const client = web.connectRelay(
      { http: BASE, ws: BASE.replace('https', 'wss') },
      { onEvent: (e) => got.push(e.id), onReset: () => (resets += 1), onStatus: (s) => statuses.push(s) },
      {
        // The relay authenticates by the Access JWT (Access adds it to the browser's same-origin requests).
        fetch: async (url) => {
          const res = await r.fetch(url.slice(BASE.length), { headers: { [H]: jwt } });
          return { ok: res.ok, json: () => res.json() };
        },
        WebSocket: FakeWs,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
      },
    );
    // Two live events while (or after) history loads: fanned out to every UI socket.
    r.pushed.length = 0;
    for (let i = 4; i <= 5; i++) await r.post(makeEvent(i));
    for (const s of r.pushed) fanout(sockets.map((x) => x.ui), eventMessage(r.core.boot, s), NOW0);
    await new Promise((res) => setTimeout(res, 50));
    client.close();
    expect(got).toEqual([1, 2, 3, 4, 5].map((n) => makeEvent(n).id));
    expect(statuses).toContain('live');
    expect(resets).toBe(0);
    expect(sockets.map((x) => (x.client as FakeWs).url)).toEqual([`${BASE.replace('https', 'wss')}/ws/ui`]);
    expect(sent).toEqual([]); // no token message to the relay (keep-alive pings start after 30 s)
  });

  it('V1-05: the web client uses the relay keep-alive strings and close codes', () => {
    expect(web.PING_MESSAGE).toBe(PING_MESSAGE);
    expect(web.PONG_MESSAGE).toBe(PONG_MESSAGE);
    expect(web.CLOSE_REPLACED).toBe(CLOSE_REPLACED);
    expect(web.CLOSE_LOGIN_EXPIRED).toBe(CLOSE_LOGIN_EXPIRED);
  });
});
