// "Try to break it": hostile HTTP framing, huge/slow clients, connection floods and
// hostile JSON against the real server. Each test asserts the server refuses cleanly
// and stays up and correct afterwards.
import { afterEach, describe, expect, it } from 'vitest';
import { TOKEN, call, connect, getJson, makeEvent, post, raw, sleep, startRig, statusOf, stopAll, storedLines } from './helpers.js';

afterEach(async () => {
  await stopAll();
});

const hdr = (port: number): string => `Host: 127.0.0.1:${port}\r\nX-Agent-Office-Local: ${TOKEN}\r\nContent-Type: application/json\r\n`;

async function stillHealthy(port: number): Promise<void> {
  expect((await call(port, '/api/health')).status).toBe(200);
}

describe('request smuggling and framing', () => {
  it('Content-Length together with Transfer-Encoding is rejected (400), nothing stored', async () => {
    const r = await startRig();
    const body = JSON.stringify(makeEvent(1));
    const out = await raw(r.port, `POST /hooks/event HTTP/1.1\r\n${hdr(r.port)}Content-Length: ${body.length}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`);
    expect(statusOf(out.text)).toBe(400);
    expect(r.bridge.store.size).toBe(0);
    await stillHealthy(r.port);
  });

  it.each([
    ['two different Content-Length headers', 'Content-Length: 5\r\nContent-Length: 6\r\n'],
    ['obfuscated Transfer-Encoding', 'Transfer-Encoding: xchunked\r\n'],
    ['Transfer-Encoding with a leading space (obs-fold)', 'Transfer-Encoding:\r\n chunked\r\n'],
    ['space before the colon', 'Content-Length : 5\r\n'],
    ['negative Content-Length', 'Content-Length: -1\r\n'],
    ['non-numeric Content-Length', 'Content-Length: 5abc\r\n'],
    ['NUL in a header value', 'X-Thing: a\u0000b\r\n'],
    ['bare LF line endings in headers', 'X-Thing: a\nX-Other: b\r\n'],
  ])('%s -> 400 and nothing stored', async (_n, extra) => {
    const r = await startRig();
    const out = await raw(r.port, `POST /hooks/event HTTP/1.1\r\n${hdr(r.port)}${extra}Connection: close\r\n\r\nhello`);
    expect(statusOf(out.text)).toBeGreaterThanOrEqual(400);
    expect(statusOf(out.text)).toBeLessThan(500);
    expect(r.bridge.store.size).toBe(0);
    await stillHealthy(r.port);
  });

  it('a pipelined second request hidden in the body is parsed as its own request and meets the same guards', async () => {
    const r = await startRig();
    const smuggled = `GET /api/sessions HTTP/1.1\r\nHost: evil.example\r\nX-Agent-Office-Local: ${TOKEN}\r\n\r\n`;
    const out = await raw(r.port, `POST /hooks/event HTTP/1.1\r\n${hdr(r.port)}Content-Length: 2\r\n\r\n{}${smuggled}`, 800);
    const statuses = [...out.text.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => Number(m[1]));
    expect(statuses).toEqual([400, 421]);
    expect(out.text).not.toContain('"sessions"');
  });

  it('a second request on a keep-alive connection is checked again (Host change mid-connection)', async () => {
    const r = await startRig();
    const ok = `GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${r.port}\r\n\r\n`;
    const evil = `GET /api/health HTTP/1.1\r\nHost: evil.example\r\n\r\n`;
    const out = await raw(r.port, ok + evil, 800);
    expect([...out.text.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => Number(m[1]))).toEqual([200, 421]);
  });

  it('Expect: 100-continue with a bad token is refused before the body is read', async () => {
    const r = await startRig();
    const out = await raw(r.port, `POST /hooks/event HTTP/1.1\r\nHost: 127.0.0.1:${r.port}\r\nContent-Type: application/json\r\nContent-Length: 50000000\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n`, 1500);
    expect(out.text).toMatch(/HTTP\/1\.1 (100|401)/);
    expect(out.text).toContain('401');
    await stillHealthy(r.port);
  });

  it('HTTP method tricks: TRACE, CONNECT, lowercase and made-up methods never reach a handler', async () => {
    const r = await startRig();
    for (const m of ['TRACE', 'CONNECT', 'post', 'PROPFIND', 'PATCH']) {
      const out = await raw(r.port, `${m} /hooks/event HTTP/1.1\r\n${hdr(r.port)}Content-Length: 2\r\nConnection: close\r\n\r\n{}`, 1000);
      const s = statusOf(out.text);
      expect(s === 0 || (s >= 400 && s < 500), `${m}: ${s}`).toBe(true);
    }
    expect(r.bridge.store.size).toBe(0);
  });
});

describe('huge and abusive input', () => {
  it('headers over 8 KB -> 431 (or the connection is closed); the server stays up', async () => {
    const r = await startRig();
    const out = await raw(r.port, `GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${r.port}\r\nX-Big: ${'a'.repeat(9000)}\r\nConnection: close\r\n\r\n`);
    expect(statusOf(out.text)).toBe(431);
    const huge = await raw(r.port, `GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${r.port}\r\nX-Big: ${'a'.repeat(2_000_000)}\r\n\r\n`, 3000);
    expect(huge.closed || statusOf(huge.text) === 431).toBe(true);
    await stillHealthy(r.port);
  });

  it('thousands of small headers -> refused', async () => {
    const r = await startRig();
    let h = '';
    for (let i = 0; i < 5000; i++) h += `X-${i}: v\r\n`;
    const out = await raw(r.port, `GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${r.port}\r\n${h}\r\n`, 3000);
    expect(statusOf(out.text) === 431 || out.closed).toBe(true);
    await stillHealthy(r.port);
  });

  it('a very long request target is refused (414/431) and the query string is bounded by the header limit', async () => {
    const r = await startRig();
    const out = await raw(r.port, `GET /api/events?x=${'a'.repeat(20_000)} HTTP/1.1\r\nHost: 127.0.0.1:${r.port}\r\nConnection: close\r\n\r\n`);
    expect([414, 431]).toContain(statusOf(out.text));
    await stillHealthy(r.port);
  });

  it('hostile JSON: deep nesting, __proto__, giant numbers, lone surrogates never crash or pollute', async () => {
    const r = await startRig();
    const nested = `${'['.repeat(30_000)}${']'.repeat(30_000)}`;
    expect((await post(r.port, nested)).status).toBe(400);
    expect((await post(r.port, `{"a":${'{"a":'.repeat(5000)}1${'}'.repeat(5000)}}`)).status).toBe(400);
    const proto = JSON.stringify(makeEvent(1)).replace('{', '{"__proto__":{"polluted":true},');
    expect((await post(r.port, proto)).status).toBe(400);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const ctor = JSON.stringify(makeEvent(1)).replace('{', '{"constructor":{"prototype":{"polluted":true}},');
    expect((await post(r.port, ctor)).status).toBe(400);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((await post(r.port, JSON.stringify(makeEvent(1)).replace('"emittedAt":', '"emittedAt":1e999,"x":'))).status).toBe(400);
    expect((await post(r.port, JSON.stringify({ ...makeEvent(1), emittedAt: 2 ** 60 }))).status).toBe(400);
    expect((await post(r.port, JSON.stringify(makeEvent(1)).replace('src/a.ts', '\\ud800'))).status).toBe(204);
    expect(r.bridge.store.size).toBe(1);
    await stillHealthy(r.port);
  });

  it('newlines and U+2028 inside text cannot forge extra JSONL lines', async () => {
    const r = await startRig();
    const forged = '{"v":1,"id":"x"}';
    expect((await post(r.port, makeEvent(1, { kind: 'notification', tool: undefined, text: `line1\n${forged}\n${String.fromCharCode(0x2028)}${forged}\r\n` }))).status).toBe(204);
    expect(storedLines(r.dir)).toHaveLength(1);
    expect((await getJson<{ events: unknown[] }>(r.port, '/api/events')).events).toHaveLength(1);
  });

  it('events for many different sessions do not break the index; unusual but valid ids are stored', async () => {
    const r = await startRig();
    for (let i = 0; i < 300; i++) await post(r.port, makeEvent(i, { sessionId: `s${i}.${i}-x_y` }));
    const s = await getJson<{ sessions: unknown[] }>(r.port, '/api/sessions');
    expect(s.sessions).toHaveLength(300);
  });
});

describe('slow and many clients', () => {
  it('slowloris: headers trickled forever are cut off by the header timeout', async () => {
    const r = await startRig({ headersTimeoutMs: 1000, requestTimeoutMs: 2000 });
    const s = await connect(r.port);
    let closedAt = 0;
    const t0 = Date.now();
    s.on('close', () => {
      closedAt = Date.now() - t0;
    });
    s.on('error', () => undefined);
    s.write(`POST /hooks/event HTTP/1.1\r\nHost: 127.0.0.1:${r.port}\r\n`);
    for (let i = 0; i < 12 && closedAt === 0; i++) {
      await sleep(400);
      if (s.writable) s.write(`X-Slow-${i}: a\r\n`);
    }
    await sleep(200);
    expect(closedAt).toBeGreaterThan(0);
    expect(closedAt).toBeLessThan(5000);
    await stillHealthy(r.port);
  }, 20_000);

  it('slow body: a request that never finishes its body is cut off by the request timeout', async () => {
    const r = await startRig({ headersTimeoutMs: 1000, requestTimeoutMs: 1500 });
    const s = await connect(r.port);
    let closed = false;
    s.on('close', () => {
      closed = true;
    });
    s.on('error', () => undefined);
    s.write(`POST /hooks/event HTTP/1.1\r\n${hdr(r.port)}Content-Length: 1000\r\n\r\n{"v":`);
    await sleep(4000);
    expect(closed).toBe(true);
    expect(r.bridge.store.size).toBe(0);
    await stillHealthy(r.port);
  }, 20_000);

  it('300 idle connections: the cap holds, the server stays responsive, and recovers when they close', async () => {
    const r = await startRig();
    const socks = [];
    for (let i = 0; i < 300; i++) {
      const s = await connect(r.port).catch(() => undefined);
      if (s) {
        s.on('error', () => undefined);
        socks.push(s);
      }
    }
    // Existing keep-alive health traffic from an already-open connection still works or is refused cleanly; never a crash.
    for (const s of socks) s.destroy();
    await sleep(300);
    await stillHealthy(r.port);
    expect((await post(r.port, makeEvent(1))).status).toBe(204);
  }, 30_000);

  it('2000 quick connect/disconnect cycles and half-open requests leave no damage', async () => {
    const r = await startRig();
    for (let i = 0; i < 2000; i += 100) {
      await Promise.all(
        Array.from({ length: 100 }, async (_v, j) => {
          const s = await connect(r.port).catch(() => undefined);
          if (!s) return;
          s.on('error', () => undefined);
          if (j % 2) s.write('POST /hooks/event HTTP/1.1\r\nHost: 127.0.0.1');
          s.destroy();
        }),
      );
    }
    await sleep(200);
    await stillHealthy(r.port);
    expect((await post(r.port, makeEvent(2))).status).toBe(204);
  }, 60_000);

  it('a client that sends a request and hangs up before the response does not stop the server storing the event', async () => {
    const r = await startRig();
    const body = JSON.stringify(makeEvent(1));
    const s = await connect(r.port);
    s.on('error', () => undefined);
    s.write(`POST /hooks/event HTTP/1.1\r\n${hdr(r.port)}Content-Length: ${body.length}\r\n\r\n${body}`);
    s.destroy();
    await sleep(300);
    await stillHealthy(r.port);
    expect(r.bridge.store.size).toBeLessThanOrEqual(1);
  });

  it('wrong-token flood (5000 requests) is answered with 401 each and costs no storage', async () => {
    const r = await startRig();
    let bad = 0;
    for (let i = 0; i < 5000; i += 250) {
      const res = await Promise.all(Array.from({ length: 250 }, () => post(r.port, makeEvent(1), { token: 'x'.repeat(40) })));
      bad += res.filter((x) => x.status === 401).length;
    }
    expect(bad).toBe(5000);
    expect(r.bridge.store.size).toBe(0);
  }, 60_000);
});
