import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_FILE, ConfigError, DEFAULT_PORT, TOKEN_FILE, dataDirOf, loadConfig } from '../src/config.js';
import { TOKEN, tempDir } from './helpers.js';

const posix = process.platform !== 'win32';
const load = (home: string, extra: Record<string, string> = {}) => loadConfig({ AGENT_OFFICE_HOME: home, ...extra });
const fail = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  throw new Error('expected a ConfigError');
};

describe('data folder', () => {
  it('AGENT_OFFICE_HOME wins, then USERPROFILE, then HOME', () => {
    expect(dataDirOf({ AGENT_OFFICE_HOME: '/x/y' })).toBe('/x/y');
    expect(dataDirOf({ USERPROFILE: join('/u', 'me'), HOME: '/h' })).toBe(join('/u', 'me', '.agent-office'));
    expect(dataDirOf({ HOME: '/h' })).toBe(join('/h', '.agent-office'));
    expect(dataDirOf({ AGENT_OFFICE_HOME: '   ', HOME: '/h' })).toBe(join('/h', '.agent-office'));
  });

  it('creates the folder (user-only on POSIX)', () => {
    const home = join(tempDir(), 'a', 'b');
    load(home);
    expect(statSync(home).isDirectory()).toBe(true);
    if (posix) expect(statSync(home).mode & 0o077).toBe(0);
  });
});

describe('local token', () => {
  it('is generated when missing: 43 base64url characters, user-only file, reused afterwards', () => {
    const home = tempDir();
    const a = load(home);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const file = join(home, TOKEN_FILE);
    expect(readFileSync(file, 'utf8')).toBe(`${a.token}\n`);
    if (posix) expect(statSync(file).mode & 0o077).toBe(0);
    expect(load(home).token).toBe(a.token);
  });

  it('an existing token file is used as is (surrounding whitespace trimmed)', () => {
    const home = tempDir();
    writeFileSync(join(home, TOKEN_FILE), `  ${TOKEN}\r\n`);
    expect(load(home).token).toBe(TOKEN);
  });

  it.each([
    ['too short', 'abc'],
    ['bad characters', `${TOKEN}!!`],
    ['empty', ''],
    ['two lines', `${TOKEN}\n${TOKEN}`],
  ])('an invalid token file (%s) stops the bridge, is never overwritten, and is not echoed', (_n, content) => {
    const home = tempDir();
    writeFileSync(join(home, TOKEN_FILE), content);
    const msg = fail(() => load(home));
    expect(msg).toContain(TOKEN_FILE);
    if (content.length > 3) expect(msg).not.toContain(content);
    expect(readFileSync(join(home, TOKEN_FILE), 'utf8')).toBe(content);
  });

  it('a directory, or a FIFO, as the token file is refused without hanging', () => {
    const home = tempDir();
    mkdirSync(join(home, TOKEN_FILE));
    fail(() => load(home));
    if (!posix) return;
    const home2 = tempDir();
    execFileSync('mkfifo', [join(home2, TOKEN_FILE)]);
    const t0 = Date.now();
    fail(() => load(home2));
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('a file of 1 KB or more is refused', () => {
    const home = tempDir();
    writeFileSync(join(home, TOKEN_FILE), 'a'.repeat(5000));
    fail(() => load(home));
  });
});

describe('config.json', () => {
  const withConfig = (obj: unknown, raw = false): string => {
    const home = tempDir();
    writeFileSync(join(home, CONFIG_FILE), raw ? String(obj) : JSON.stringify(obj));
    return home;
  };

  it('defaults: port 47821, no claudePath, events under the data folder', () => {
    const home = tempDir();
    const c = load(home);
    expect(c).toMatchObject({ port: DEFAULT_PORT, claudePath: undefined, eventsDir: join(home, 'events'), tokenFile: join(home, TOKEN_FILE), dataDir: home });
    expect(DEFAULT_PORT).toBe(47821);
  });

  it('reads port, claudePath (POSIX and Windows absolute paths) and eventsDir; unknown keys (later tasks) are allowed', () => {
    const abs = join(tempDir(), 'events-elsewhere');
    expect(load(withConfig({ port: 50000, claudePath: '/opt/claude/bin/claude', eventsDir: abs, repos: { a: 'b' } }))).toMatchObject({ port: 50000, claudePath: '/opt/claude/bin/claude', eventsDir: abs, relay: undefined });
    expect(load(withConfig({ claudePath: 'C:\\Users\\po\\AppData\\Local\\claude\\claude.exe' })).claudePath).toBe('C:\\Users\\po\\AppData\\Local\\claude\\claude.exe');
  });

  it('AGENT_OFFICE_BRIDGE_PORT (the variable the emit script reads) overrides config.json; a bad value is ignored', () => {
    const home = withConfig({ port: 50000 });
    expect(load(home, { AGENT_OFFICE_BRIDGE_PORT: '51000' }).port).toBe(51000);
    for (const bad of ['0', '70000', 'abc', '12 34', '', '-1', '1e3']) expect(load(home, { AGENT_OFFICE_BRIDGE_PORT: bad }).port, bad).toBe(50000);
  });

  it.each<[string, unknown]>([
    ['port 0', { port: 0 }],
    ['port below 1024 (the emit script ignores it, so the two would disagree)', { port: 1023 }],
    ['port too high', { port: 65536 }],
    ['port as a string', { port: '47821' }],
    ['port fractional', { port: 1.5 }],
    ['relative claudePath', { claudePath: 'claude' }],
    ['relative claudePath with ..', { claudePath: '../claude' }],
    ['claudePath with a newline', { claudePath: '/a/b\n/c' }],
    ['claudePath not a string', { claudePath: ['/a'] }],
    ['empty claudePath', { claudePath: '' }],
    ['relative eventsDir', { eventsDir: 'events' }],
    ['not an object', [1, 2]],
  ])('invalid: %s -> ConfigError naming the field, never the value', (_n, obj) => {
    const secret = ['planted', 'value', 'abc'].join('-');
    const home = withConfig(Array.isArray(obj) ? obj : { ...(obj as object), note: secret });
    const msg = fail(() => load(home));
    expect(msg).toContain(CONFIG_FILE);
    expect(msg).not.toContain(secret);
  });

  it('invalid JSON, a directory and an oversized file are refused', () => {
    fail(() => load(withConfig('{"port": ', true)));
    const home = tempDir();
    mkdirSync(join(home, CONFIG_FILE));
    fail(() => load(home));
    fail(() => load(withConfig(`{"a":"${'x'.repeat(70_000)}"}`, true)));
  });

  it('a leading UTF-8 BOM (PowerShell 5.1 Set-Content -Encoding UTF8) is ignored; a BOM elsewhere is still invalid JSON', () => {
    const body = JSON.stringify({ port: 50001, relayUrl: 'https://relay.example', bridgeToken: 'b'.repeat(40) });
    const home = tempDir();
    writeFileSync(join(home, CONFIG_FILE), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body)]));
    expect(load(home)).toMatchObject({ port: 50001, relay: { host: 'relay.example' } });
    fail(() => load(withConfig(`\uFEFF\uFEFF${body}`, true)));
    fail(() => load(withConfig(`{"port":\uFEFF50001}`, true)));
  });

  describe('relay forwarding (V1-04): relayUrl + bridgeToken', () => {
    const bridgeToken = 'r'.repeat(20) + 'X7'.repeat(12);

    it('both set: wss URL to /bridge, host for logs, the token', () => {
      expect(load(withConfig({ relayUrl: 'https://agent-office.example.workers.dev', bridgeToken })).relay).toEqual({
        url: 'wss://agent-office.example.workers.dev/bridge',
        host: 'agent-office.example.workers.dev',
        token: bridgeToken,
      });
      expect(load(withConfig({ relayUrl: 'https://relay.example/', bridgeToken })).relay?.url).toBe('wss://relay.example/bridge');
      expect(load(withConfig({ relayUrl: 'http://127.0.0.1:8787', bridgeToken })).relay?.url).toBe('ws://127.0.0.1:8787/bridge');
    });

    it('neither set: off', () => {
      expect(load(tempDir()).relay).toBeUndefined();
    });

    it.each<[string, Record<string, unknown>]>([
      ['only relayUrl', { relayUrl: 'https://relay.example' }],
      ['only bridgeToken', { bridgeToken }],
    ])('%s: refused, no token file created', (_n, obj) => {
      const home = withConfig(obj);
      expect(fail(() => load(home))).toMatch(/both relayUrl and bridgeToken/);
      expect(() => readFileSync(join(home, TOKEN_FILE))).toThrow();
    });

    it.each([
      ['plain http to a public host', 'http://relay.example'],
      ['wss scheme', 'wss://relay.example'],
      ['a path', 'https://relay.example/bridge'],
      ['a query', 'https://relay.example/?x=1'],
      ['userinfo', 'https://u:p@relay.example'],
      ['not a URL', 'relay.example'],
      ['a file URL', 'file:///etc/passwd'],
    ])('relayUrl with %s is refused (field named, value not echoed)', (_n, relayUrl) => {
      const msg = fail(() => load(withConfig({ relayUrl, bridgeToken })));
      expect(msg).toContain('relayUrl');
      expect(msg).not.toContain(bridgeToken);
    });

    it.each([
      ['too short', 'abc'],
      ['bad characters', `${bridgeToken}!`],
      ['not a string', 42],
    ])('bridgeToken %s is refused without echoing it', (_n, token) => {
      const msg = fail(() => load(withConfig({ relayUrl: 'https://relay.example', bridgeToken: token })));
      expect(msg).toContain('bridgeToken');
      expect(msg).not.toContain(String(token));
    });

    it('bridgeToken equal to the local token is refused (the local token never leaves the PC)', () => {
      const home = withConfig({ relayUrl: 'https://relay.example', bridgeToken: TOKEN });
      writeFileSync(join(home, TOKEN_FILE), `${TOKEN}\n`);
      const msg = fail(() => load(home));
      expect(msg).toMatch(/not the local-token/);
      expect(msg).not.toContain(TOKEN);
    });
  });

  it('a config error does not create a token (nothing half-done)', () => {
    const home = withConfig({ port: 0 });
    fail(() => load(home));
    expect(() => readFileSync(join(home, TOKEN_FILE))).toThrow();
  });
});
