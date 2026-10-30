// V1-04 bridge side: the relay client against a fake relay (test/fakeRelay.ts).
// AC: relay down -> 50 events buffered -> relay back -> all 50 delivered once.
// Also: buffer cap (oldest dropped), resend of unacked events after a reconnect,
// reject/retry answers, keep-alive, the Bearer header, and that neither the local
// token nor the bridge token ever shows up where it must not.
import { afterEach, describe, expect, it } from 'vitest';
import type { RelayConfig } from '../src/config.js';
import { RelayClient } from '../src/relayClient.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { TOKEN, call, makeEvent, post, sleep, startRig, stopAll } from './helpers.js';

/** Built at run time (secret scan); differs from the local TOKEN. */
const BRIDGE_TOKEN = 'b'.repeat(21) + 'Z9'.repeat(11);
const FAST = { backoffMs: [50, 100, 200], replacedRetryMs: 300, pingMs: 100, pongTimeoutMs: 150, handshakeTimeoutMs: 1000 };

const relays: FakeRelay[] = [];
afterEach(async () => {
  await stopAll();
  await Promise.all(relays.splice(0).map((r) => r.stop()));
});

async function fakeRelay(): Promise<FakeRelay> {
  const r = await startFakeRelay(BRIDGE_TOKEN);
  relays.push(r);
  return r;
}

function relayConfig(r: FakeRelay, token = BRIDGE_TOKEN): RelayConfig {
  return { url: r.url, host: `127.0.0.1:${r.port}`, token };
}

async function waitUntil(pred: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(20);
  }
}

const health = async (port: number): Promise<{ relay: string }> => JSON.parse((await call(port, '/api/health', { token: false })).body) as { relay: string };

describe('relay client', () => {
  it('AC: relay down -> 50 events buffered -> relay back -> all 50 delivered exactly once; health follows', async () => {
    const relay = await fakeRelay();
    const rig = await startRig({ relay: relayConfig(relay), relayTuning: FAST });
    await waitUntil(() => rig.bridge.relay?.status() === 'connected');
    expect((await health(rig.port)).relay).toBe('connected');

    await relay.stop(); // "kill relay"
    await waitUntil(() => rig.bridge.relay?.status() === 'offline');
    expect((await health(rig.port)).relay).toBe('offline');

    const ids: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      const e = makeEvent(i);
      ids.push(e.id);
      expect((await post(rig.port, e)).status).toBe(204);
    }
    expect(rig.bridge.relay?.buffered).toBe(50);

    await relay.start();
    await waitUntil(() => relay.stored.length === 50);
    await waitUntil(() => rig.bridge.relay?.buffered === 0);
    expect(relay.stored).toEqual(ids); // oldest first
    expect([...relay.received.values()].every((n) => n === 1)).toBe(true);
    expect((await health(rig.port)).relay).toBe('connected');
    expect(rig.lines.some((l) => l.startsWith('info relay connected (50 buffered'))).toBe(true);
  });

  it('live events go straight out while connected; duplicates posted to the bridge are not resent', async () => {
    const relay = await fakeRelay();
    const rig = await startRig({ relay: relayConfig(relay), relayTuning: FAST });
    await waitUntil(() => rig.bridge.relay?.status() === 'connected');
    const e = makeEvent(1);
    await post(rig.port, e);
    await post(rig.port, e); // duplicate id at the bridge: stored once, forwarded once
    await waitUntil(() => relay.stored.length === 1);
    await sleep(100);
    expect(relay.received.get(e.id)).toBe(1);
  });

  it('upgrade carries Bearer BRIDGE_TOKEN; the local token is never sent, and no token is logged', async () => {
    const relay = await fakeRelay();
    const rig = await startRig({ relay: relayConfig(relay), relayTuning: FAST });
    await waitUntil(() => rig.bridge.relay?.status() === 'connected');
    await post(rig.port, makeEvent(1, { text: 'hello' }));
    await waitUntil(() => relay.stored.length === 1);
    await sleep(250); // a few pings
    expect(relay.upgrades[0]?.authorization).toBe(`Bearer ${BRIDGE_TOKEN}`);
    expect(relay.upgrades[0]?.origin).toBeUndefined();
    const everything = JSON.stringify(relay.upgrades) + relay.raw.join('\n');
    expect(everything).not.toContain(TOKEN);
    expect(everything.toLowerCase()).not.toContain('x-agent-office-local');
    const log = rig.lines.join('\n');
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain(BRIDGE_TOKEN);
    expect(log).not.toContain('hello');
  });

  it('buffer cap: only the newest maxBuffer events survive an outage; one warning', async () => {
    const relay = await fakeRelay();
    await relay.stop();
    const rig = await startRig({ relay: relayConfig(relay), relayTuning: { ...FAST, maxBuffer: 10 } });
    const ids: string[] = [];
    for (let i = 0; i < 15; i += 1) {
      const e = makeEvent(i);
      ids.push(e.id);
      await post(rig.port, e);
    }
    expect(rig.bridge.relay?.buffered).toBe(10);
    expect(rig.lines.filter((l) => l.startsWith('warn relay buffer full'))).toHaveLength(1);
    await relay.start();
    await waitUntil(() => relay.stored.length === 10);
    expect(relay.stored).toEqual(ids.slice(5));
    expect(rig.lines.some((l) => l.includes('5 dropped while offline'))).toBe(true);
  });

  it('the default buffer is 1000', async () => {
    const relay = await fakeRelay();
    await relay.stop();
    const rig = await startRig({ relay: relayConfig(relay), relayTuning: FAST });
    const client = rig.bridge.relay;
    if (!client) throw new Error('no relay client');
    for (let i = 0; i < 1005; i += 1) client.push(makeEvent(i));
    expect(client.buffered).toBe(1000);
  });

  it('sent but unacked events are resent after a reconnect, then acked once', async () => {
    const relay = await fakeRelay();
    relay.mode = 'silent';
    const rig = await startRig({ relay: relayConfig(relay), relayTuning: FAST });
    await waitUntil(() => rig.bridge.relay?.status() === 'connected');
    for (let i = 0; i < 5; i += 1) await post(rig.port, makeEvent(i));
    await waitUntil(() => relay.received.size === 5);
    expect(rig.bridge.relay?.buffered).toBe(5);
    relay.mode = 'ack';
    for (const ws of relay.sockets) ws.terminate(); // connection drops before any ack
    await waitUntil(() => relay.stored.length === 5);
    await waitUntil(() => rig.bridge.relay?.buffered === 0);
    expect([...relay.received.values()]).toEqual([2, 2, 2, 2, 2]);
  });

  it('reject: the event is dropped (never retried) and logged by kind + id prefix only', async () => {
    const relay = await fakeRelay();
    relay.mode = 'reject';
    const rig = await startRig({ relay: relayConfig(relay), relayTuning: FAST });
    await waitUntil(() => rig.bridge.relay?.status() === 'connected');
    const e = makeEvent(1);
    await post(rig.port, e);
    await waitUntil(() => rig.bridge.relay?.buffered === 0);
    for (const ws of relay.sockets) ws.terminate();
    await waitUntil(() => relay.upgrades.length >= 2 && rig.bridge.relay?.status() === 'connected');
    await sleep(100);
    expect(relay.received.get(e.id)).toBe(1);
    expect(rig.lines).toContain(`event tool.start ${e.id.slice(0, 8)} relay-reject`);
  });

  it('retry (rate limited): pauses, then resends', async () => {
    const relay = await fakeRelay();
    relay.mode = 'retry';
    const rig = await startRig({ relay: relayConfig(relay), relayTuning: FAST });
    await waitUntil(() => rig.bridge.relay?.status() === 'connected');
    const e = makeEvent(1);
    await post(rig.port, e);
    await waitUntil(() => relay.received.get(e.id) === 1);
    relay.mode = 'ack';
    await sleep(300);
    expect(relay.stored).toHaveLength(0); // still paused (1 s)
    await waitUntil(() => relay.stored.length === 1, 3000);
    expect(rig.lines.some((l) => l.startsWith('warn relay rate limit: pausing 1 s'))).toBe(true);
  });

  it('a relay that stops answering pings is dropped and reconnected', async () => {
    const relay = await fakeRelay();
    relay.pong = false;
    const rig = await startRig({ relay: relayConfig(relay), relayTuning: FAST });
    await waitUntil(() => relay.upgrades.length >= 2, 3000);
    expect(rig.lines.some((l) => l.includes('did not answer the keep-alive'))).toBe(true);
  });

  it('401 from the relay: offline with a hint, keeps retrying, never logs the token', async () => {
    const relay = await fakeRelay();
    const rig = await startRig({ relay: relayConfig(relay, 'w'.repeat(40)), relayTuning: FAST });
    await waitUntil(() => relay.upgrades.length >= 3);
    expect(rig.bridge.relay?.status()).toBe('offline');
    const warn = rig.lines.find((l) => l.startsWith('warn relay offline (HTTP 401'));
    expect(warn).toMatch(/does not match the relay secret/);
    expect(rig.lines.join('\n')).not.toContain('w'.repeat(40));
    // Same reason again is not logged on every attempt.
    expect(rig.lines.filter((l) => l.startsWith('warn relay offline (HTTP 401')).length).toBe(1);
  });

  it('503 from the relay: hint says the secret is missing', async () => {
    const relay = await fakeRelay();
    relay.refuse = 503;
    const rig = await startRig({ relay: relayConfig(relay), relayTuning: FAST });
    await waitUntil(() => rig.lines.some((l) => l.startsWith('warn relay offline (HTTP 503')));
    expect(rig.lines.find((l) => l.startsWith('warn relay offline (HTTP 503'))).toMatch(/no BRIDGE_TOKEN secret/);
  });

  it('closed with 4000 (another bridge took over): waits replacedRetryMs before trying again', async () => {
    const relay = await fakeRelay();
    const rig = await startRig({ relay: relayConfig(relay), relayTuning: FAST });
    await waitUntil(() => rig.bridge.relay?.status() === 'connected');
    for (const ws of relay.sockets) ws.close(4000, 'replaced');
    await waitUntil(() => rig.lines.some((l) => l.includes('another bridge took over')));
    expect(relay.upgrades).toHaveLength(1);
    await waitUntil(() => relay.upgrades.length === 2, 2000);
  });

  it('only local events are forwarded', () => {
    const lines: string[] = [];
    const client = new RelayClient({ url: 'ws://127.0.0.1:1/bridge', host: 'x', token: BRIDGE_TOKEN, logger: { event: () => undefined, info: (m) => lines.push(m), warn: (m) => lines.push(m) } });
    client.push(makeEvent(1, { source: 'cloud' }));
    client.push(makeEvent(2));
    expect(client.buffered).toBe(1);
  });

  it('relay off (no config): no client, health says offline, nothing dialled', async () => {
    const rig = await startRig();
    expect(rig.bridge.relay).toBeNull();
    expect((await health(rig.port)).relay).toBe('offline');
  });

  it('stop() closes the socket and stops reconnecting', async () => {
    const relay = await fakeRelay();
    const rig = await startRig({ relay: relayConfig(relay), relayTuning: FAST });
    await waitUntil(() => rig.bridge.relay?.status() === 'connected');
    await rig.stop();
    await waitUntil(() => relay.sockets.size === 0);
    const n = relay.upgrades.length;
    await sleep(300);
    expect(relay.upgrades.length).toBe(n);
  });
});
