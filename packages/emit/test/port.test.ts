// B-07: emit and bridge agree on the port. env var > config.json `port` > 47821.
import { execFileSync } from 'node:child_process';
import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_BRIDGE_PORT, bridgePort, resolveDestination } from '../src/destination.js';
import { MAX_CONFIG_FILE_BYTES, readConfigPort } from '../src/portfile.js';
import { BUILT, LOCAL_HEADER_VALUE, buildEmit, dataDirWithToken, fixture, mockServer, runEmit, tempDir } from './helpers.js';

const posix = process.platform !== 'win32';
const writeConfig = (dir: string, v: unknown): void => {
  writeFileSync(join(dir, 'config.json'), typeof v === 'string' ? v : JSON.stringify(v));
};

describe('readConfigPort', () => {
  const read = (v: unknown): number | undefined => {
    const dir = tempDir();
    writeConfig(dir, v);
    return readConfigPort(join(dir, 'config.json'));
  };

  it('reads an integer port from 1024 to 65535 and ignores other keys', () => {
    expect(read({ port: 50123, claudePath: 'C:\\x\\claude.exe', relayUrl: 'https://x.example' })).toBe(50123);
    expect(read({ port: 1024 })).toBe(1024);
    expect(read({ port: 65535 })).toBe(65535);
  });

  it.each<[string, unknown]>([
    ['below 1024', { port: 1023 }],
    ['zero', { port: 0 }],
    ['above 65535', { port: 65536 }],
    ['string', { port: '50123' }],
    ['fractional', { port: 5000.5 }],
    ['null', { port: null }],
    ['array', { port: [50123] }],
    ['missing', { other: 1 }],
    ['top-level array', [50123]],
    ['top-level number', '50123'],
    ['null document', 'null'],
    ['invalid JSON', '{ "port": '],
    ['empty file', ''],
  ])('%s -> undefined', (_n, v) => {
    expect(read(v)).toBeUndefined();
  });

  it('missing file, a directory and a file of 64 KB or more -> undefined', () => {
    const dir = tempDir();
    expect(readConfigPort(join(dir, 'nope.json'))).toBeUndefined();
    expect(readConfigPort(dir)).toBeUndefined();
    const big = `{"port": 50123, "pad": "${'a'.repeat(MAX_CONFIG_FILE_BYTES)}"}`;
    writeConfig(dir, big);
    expect(readConfigPort(join(dir, 'config.json'))).toBeUndefined();
  });
});

describe('port precedence', () => {
  const tok = (): string => LOCAL_HEADER_VALUE;
  const cfg = (n: number | undefined) => (): number | undefined => n;

  it('env var > config.json > default', () => {
    expect(bridgePort({ AGENT_OFFICE_BRIDGE_PORT: '51000' }, cfg(50000))).toBe(51000);
    expect(bridgePort({}, cfg(50000))).toBe(50000);
    expect(bridgePort({}, cfg(undefined))).toBe(DEFAULT_BRIDGE_PORT);
    expect(bridgePort({})).toBe(DEFAULT_BRIDGE_PORT);
  });

  it('an invalid env var falls through to config.json (same as the bridge)', () => {
    for (const bad of ['0', '70000', 'abc', '', '12 34', '1e3']) expect(bridgePort({ AGENT_OFFICE_BRIDGE_PORT: bad }, cfg(50000)), bad).toBe(50000);
  });

  it('config.json is not read at all when the env var is valid, or when there is no token', () => {
    let reads = 0;
    const spy = (): number => {
      reads += 1;
      return 50000;
    };
    bridgePort({ AGENT_OFFICE_BRIDGE_PORT: '51000' }, spy);
    expect(resolveDestination({ AGENT_OFFICE_HOME: '/x' }, () => undefined, spy)).toBeNull();
    expect(reads).toBe(0);
  });

  it('the host is fixed to 127.0.0.1 whatever config says', () => {
    const d = resolveDestination({ AGENT_OFFICE_HOME: '/x' }, tok, cfg(50000));
    expect(d?.url).toBe('http://127.0.0.1:50000/hooks/event');
  });

  it('a cloud session never reads config.json or uses a local port', () => {
    const d = resolveDestination({ CLAUDE_CODE_REMOTE_SESSION_ID: 's', AGENT_OFFICE_RELAY_URL: 'https://r.example' }, tok, cfg(50000));
    expect(d?.source).toBe('cloud');
  });
});

describe('the built hook, port from config.json only', () => {
  beforeAll(() => {
    buildEmit();
  }, 60_000);

  it('delivers to the port in config.json when no env var is set', async () => {
    const m = await mockServer();
    try {
      const home = dataDirWithToken();
      writeConfig(home, { port: m.port });
      const r = await runEmit(fixture('pc2', '001-SessionStart-exec.json'), { AGENT_OFFICE_HOME: home }, BUILT);
      expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(m.requests).toHaveLength(1);
      expect(m.requests[0]?.headers['x-agent-office-local']).toBe(LOCAL_HEADER_VALUE);
    } finally {
      await m.close();
    }
  }, 20_000);

  it('the env var wins over a different config.json port', async () => {
    const m = await mockServer();
    try {
      const home = dataDirWithToken();
      writeConfig(home, { port: m.port === 60000 ? 60001 : 60000 });
      await runEmit(fixture('pc2', '001-SessionStart-exec.json'), { AGENT_OFFICE_HOME: home, AGENT_OFFICE_BRIDGE_PORT: String(m.port) }, BUILT);
      expect(m.requests).toHaveLength(1);
    } finally {
      await m.close();
    }
  }, 20_000);

  const hostile: [string, (dir: string) => void][] = [
    ['invalid JSON', (d) => { writeConfig(d, '{ nope'); }],
    ['wrong type', (d) => { writeConfig(d, { port: '50123' }); }],
    ['huge file', (d) => { writeConfig(d, `{"pad":"${'a'.repeat(5_000_000)}"}`); }],
    ['directory', (d) => execFileSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(join(d, 'config.json'))})`])],
    ...(posix
      ? ([
          ['FIFO', (d: string) => execFileSync('mkfifo', [join(d, 'config.json')])],
          ['symlink to /dev/zero', (d: string) => { symlinkSync('/dev/zero', join(d, 'config.json')); }],
        ] as [string, (dir: string) => void][])
      : []),
  ];

  it.each(hostile)('hostile config.json (%s): exits 0 at once, prints nothing, never uses the bad value', async (_n, make) => {
    const m = await mockServer();
    try {
      const home = dataDirWithToken();
      make(home);
      const r = await runEmit(fixture('pc2', '001-SessionStart-exec.json'), { AGENT_OFFICE_HOME: home }, BUILT);
      expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(r.ms).toBeLessThan(6000);
      expect(m.requests).toHaveLength(0); // fell back to 47821, not to the mock
    } finally {
      await m.close();
    }
  }, 20_000);
});
