import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'spike-s2-capture.mjs');
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'fixtures', 'hooks', 'provisional', '09-pre-tool-use-bash-tester.json',
);

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function capture(stdin, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ao-s2-'));
  dirs.push(dir);
  const r = spawnSync(process.execPath, [SCRIPT, '--form', 'exec'], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, AGENT_OFFICE_CAPTURE_DIR: dir, ...extraEnv },
  });
  const files = readdirSync(dir);
  return { r, dir, files, read: (f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) };
}

describe('spike-s2-capture hook', () => {
  it('writes one capture file, exits 0 and prints nothing to stdout', () => {
    const raw = JSON.stringify(JSON.parse(readFileSync(FIXTURE, 'utf8')).payload);
    const { r, files, read } = capture(raw);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d+-\d+-PreToolUse\.json$/);
    const rec = read(files[0]);
    expect(rec.stdinRaw).toBe(raw);
    expect(rec.capture.form).toBe('exec');
    expect(rec.capture.parsedOk).toBe(true);
    expect(rec.capture.provenance).toMatch(/OBSERVED raw capture/);
  });

  it('records env var presence only, never values', () => {
    const fakeKey = ['fake', 'value', 'never', 'written', '0123456789'].join('-');
    const { files, dir } = capture('{"hook_event_name":"Stop","session_id":"s"}', {
      ANTHROPIC_API_KEY: fakeKey,
      CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_0123456789abcdef',
      CLAUDE_PROJECT_DIR: '/some/where/agent-office',
    });
    const text = readFileSync(join(dir, files[0]), 'utf8');
    expect(text).not.toContain(fakeKey);
    expect(text).not.toContain('cse_0123456789abcdef');
    const rec = JSON.parse(text);
    expect(rec.capture.env.ANTHROPIC_API_KEY).toBe(true);
    expect(rec.capture.env.CLAUDE_CODE_REMOTE_SESSION_ID).toBe(true);
    expect(rec.capture.remoteSessionIdShape).toBe('cse_');
    expect(rec.capture.projectDirBasename).toBe('agent-office');
  });

  it('still exits 0 and captures on malformed stdin', () => {
    const { r, files, read } = capture('{not json');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(files[0]).toMatch(/-unparsed\.json$/);
    expect(read(files[0]).capture.parsedOk).toBe(false);
  });

  it('sanitizes the event name used in the file name', () => {
    const { files } = capture('{"hook_event_name":"../../evil\\\\name"}');
    expect(files[0]).toMatch(/-evilname\.json$/);
  });
});
