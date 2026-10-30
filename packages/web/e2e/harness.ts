// Starts the REAL built bridge (packages/bridge/dist, which serves packages/web/dist)
// on a free port in a temp data folder, and feeds it events over POST /hooks/event.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect } from '@playwright/test';
import type { OfficeEvent } from '@agent-office/core';
import { readTeamRun } from '../test/helpers/team-run.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, '..', '..', 'bridge', 'dist', 'agent-office-bridge.mjs');

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => {
        resolve(port);
      });
    });
  });
}

export const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

export class BridgeRig {
  private n = 0;
  constructor(
    readonly port: number,
    readonly token: string,
    private readonly child: ChildProcess,
    private readonly dir: string,
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** POST one event; the bridge answers 2xx when it stores it. */
  async post(e: OfficeEvent): Promise<void> {
    const res = await fetch(`${this.url}/hooks/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Agent-Office-Local': this.token },
      body: JSON.stringify(e),
    });
    expect(res.ok, `POST /hooks/event -> ${res.status}`).toBe(true);
  }

  /** A made-up-but-valid event for load scenarios (the fixtures cover the realistic shapes). */
  event(over: Partial<OfficeEvent> & Pick<OfficeEvent, 'kind'>): OfficeEvent {
    this.n += 1;
    return { v: 1, id: sha(`rig-${this.port}-${this.n}`), emittedAt: Date.now(), source: 'local', sessionId: 'rig', repo: 'agent-office', actor: { kind: 'main', agentType: null, agentId: null }, ...over };
  }

  /**
   * The observed team run (fixtures/sessions/team-run.jsonl), moved to "now" and cut after
   * `lastKind`'s n-th occurrence, as session `sessionId`. The last kept event is `endAgoMs` old.
   */
  async playTeamRun(sessionId: string, repo: string, until: (e: OfficeEvent) => boolean, endAgoMs = 1_000): Promise<void> {
    const all = readTeamRun();
    const cut = all.findIndex(until);
    const events = all.slice(0, cut + 1);
    const last = events.at(-1)?.emittedAt ?? 0;
    const shift = Date.now() - endAgoMs - last;
    for (const e of events) {
      await this.post({ ...e, id: sha(`${sessionId}:${e.id}`), sessionId, repo, emittedAt: e.emittedAt + shift });
    }
  }

  stop(): void {
    this.child.kill('SIGKILL');
    rmSync(this.dir, { recursive: true, force: true });
  }
}

async function startRig(): Promise<BridgeRig> {
  const dir = mkdtempSync(join(tmpdir(), 'ao-e2e-'));
  const port = await freePort();
  const child = spawn(process.execPath, [BUNDLE], {
    env: { PATH: process.env.PATH ?? '', AGENT_OFFICE_HOME: dir, AGENT_OFFICE_BRIDGE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (out += d.toString()));
  const deadline = Date.now() + 15_000;
  while (!out.includes('listening on')) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`bridge did not start: ${out.slice(0, 300)} (run \`npm run build\` first)`);
    await new Promise((r) => setTimeout(r, 50));
  }
  const token = readFileSync(join(dir, 'local-token'), 'utf8').trim();
  return new BridgeRig(port, token, child, dir);
}

export const test = base.extend<{ bridge: BridgeRig }>({
  // eslint-disable-next-line no-empty-pattern
  bridge: async ({}, use) => {
    const rig = await startRig();
    await use(rig);
    rig.stop();
  },
});
export { expect };
