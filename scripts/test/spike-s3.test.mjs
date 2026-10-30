// Tests for scripts/spike-s3.mjs. They never start the real `claude`: the full
// run uses scripts/test/fixtures/fake-claude.mjs (a test double, no model usage).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  STRIPPED_ENV,
  childEnv,
  claudeArgs,
  hookSettings,
  interruptLine,
  quotePath,
  spawnTarget,
  summarize,
  userLine,
} from '../spike-s3.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'spike-s3.mjs');
const FAKE = join(HERE, 'fixtures', 'fake-claude.mjs');
const ROOT = join(HERE, '..', '..');

describe('spike-s3 helpers', () => {
  it('childEnv strips API keys case-insensitively and sets the run id', () => {
    const env = childEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'x', anthropic_auth_token: 'y', Anthropic_Api_Key: 'z', OTHER: '1' }, 'run-1');
    expect(env).toEqual({ PATH: '/bin', OTHER: '1', AGENT_OFFICE_RUN_ID: 'run-1' });
    expect(STRIPPED_ENV).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
  });

  it('argv: stream-json in/out, default permission mode, no prompt, never bare or bypass', () => {
    const args = claudeArgs('/s.json', ['--resume', 'abc']);
    expect(args.slice(0, 9)).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'default', '--settings']);
    expect(args.join(' ')).not.toMatch(/--bare|bypassPermissions|dangerously|Count from|lighthouse/);
  });

  it('stdin lines are single-line JSON', () => {
    expect(JSON.parse(userLine('hi "there"\nnext'))).toEqual({ type: 'user', message: { role: 'user', content: 'hi "there"\nnext' } });
    expect(userLine('a\nb').split('\n')).toHaveLength(2);
    expect(JSON.parse(interruptLine('r1'))).toEqual({ type: 'control_request', request_id: 'r1', request: { subtype: 'interrupt' } });
  });

  it('spawnTarget runs a cli.js under node and anything else directly', () => {
    expect(spawnTarget('C:\\x\\cli.js')).toEqual({ cmd: process.execPath, pre: ['C:\\x\\cli.js'] });
    expect(spawnTarget('C:\\x\\claude.exe')).toEqual({ cmd: 'C:\\x\\claude.exe', pre: [] });
  });

  it('hook settings: async command hooks + http hooks with the run-id header via allowedEnvVars', () => {
    const s = hookSettings(5555, 'C:\\a b\\log.txt');
    const ups = s.hooks.UserPromptSubmit[0].hooks;
    expect(ups[0]).toMatchObject({ type: 'command', async: true });
    expect(ups[0].command).toContain('--hook-log "C:/a b/log.txt"');
    expect(ups[1]).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:5555/hook',
      timeout: 10,
      headers: { 'X-Agent-Office-Run': '$AGENT_OFFICE_RUN_ID' },
      allowedEnvVars: ['AGENT_OFFICE_RUN_ID'],
    });
    expect(JSON.stringify(s)).not.toMatch(/onFailure|block/);
  });

  it('BUG-15: refuses paths a hook shell would expand ($, %, `, ", line breaks)', () => {
    for (const bad of ['C:\\Users\\$me\\log.txt', 'C:\\100%\\log.txt', 'C:\\a`b\\log.txt', 'C:\\a"b\\log.txt', 'C:\\a\nb\\log.txt']) {
      expect(() => hookSettings(5555, bad)).toThrow(/hook shell would expand/);
      expect(() => hookSettings(5555, 'C:\\ok\\log.txt', bad)).toThrow(/hook shell would expand/);
    }
    expect(quotePath("C:\\Program Files (x86)\\it's & ok\\x.mjs")).toBe(`"C:/Program Files (x86)/it's & ok/x.mjs"`);
  });

  it('summarize keeps only non-sensitive fields and caps excerpts', () => {
    expect(summarize({ type: 'system', subtype: 'init', session_id: 's', apiKeySource: 'none', cwd: '/secret', tools: ['x'] })).toEqual({
      type: 'system', subtype: 'init', hasSessionId: true, apiKeySource: 'none', permissionMode: null,
    });
    const r = summarize({ type: 'result', subtype: 'success', is_error: false, result: 'y'.repeat(500) });
    expect(r.excerpt).toHaveLength(120);
    expect(summarize({ type: 'assistant', message: { content: 'private' } })).toBeNull();
    expect(summarize(null)).toBeNull();
  });
});

describe('spike-s3 hook mode', () => {
  it('logs the event name and run id only, prints nothing, exits 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 's3-hook-'));
    try {
      const log = join(dir, 'log.txt');
      const payload = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'PRIVATE PROMPT' });
      const r = spawnSync(process.execPath, [SCRIPT, '--hook-log', log], { input: payload, encoding: 'utf8', env: { ...process.env, AGENT_OFFICE_RUN_ID: 'r9' } });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      const text = readFileSync(log, 'utf8');
      expect(JSON.parse(text)).toEqual({ event: 'UserPromptSubmit', runIdEnv: 'r9' });
      expect(text).not.toContain('PRIVATE');
      const bad = spawnSync(process.execPath, [SCRIPT, '--hook-log', log], { input: 'not json', encoding: 'utf8' });
      expect(bad.status).toBe(0);
      expect(bad.stdout).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('spike-s3 full run against a fake claude (test double)', () => {
  it('runs every step and writes a report without API keys reaching the child', () => {
    const planted = ['planted', 'test', 'value'].join('-'); // built at runtime (secret-scan convention)
    const out = mkdtempSync(join(tmpdir(), 's3-run-'));
    const r = spawnSync(process.execPath, [SCRIPT, '--run', '--claude', FAKE], {
      encoding: 'utf8',
      cwd: ROOT,
      env: { ...process.env, ANTHROPIC_API_KEY: planted, AGENT_OFFICE_S3_DIR: out },
      timeout: 60_000,
    });
    const saved = readFileSync(join(out, 'report.json'), 'utf8');
    rmSync(out, { recursive: true, force: true });
    expect(r.status, r.stderr).toBe(0);
    const m = /=== S3 REPORT START ===\n([\s\S]*)\n=== S3 REPORT END ===/.exec(r.stdout);
    expect(m).not.toBeNull();
    const report = JSON.parse(m[1]);
    expect(JSON.parse(saved)).toEqual(report);
    expect(r.stdout).not.toContain(planted);
    expect(report.parentEnvHas).toEqual({ ANTHROPIC_API_KEY: true, ANTHROPIC_AUTH_TOKEN: false });
    expect(report.resolve.candidates).toHaveLength(1);
    expect(report.resolve.candidates[0]).toMatchObject({ ok: true, ext: '.mjs' });

    expect(report.message).toMatchObject({ secondResultArrived: true, secondSaysTwo: true, sameSessionIdThroughout: true, exit: { code: 0 } });
    const init = report.message.messages.find((x) => x.subtype === 'init');
    expect(init).toMatchObject({ hasSessionId: true, apiKeySource: 'none' });

    expect(report.stopInterrupt).toMatchObject({ outputSeenBeforeStop: true, resultSubtype: 'error_during_execution', aliveAfterResult: true, acceptsNextMessage: true });
    expect(report.stopCloseStdin.exit.code).toBe(0);
    expect(report.stopKill.killedBy).toMatch(/SIGKILL|taskkill/);
    expect(report.resumeAfterInterrupt).toMatchObject({ gotResult: true, sameSessionId: true });
    expect(report.resumeAfterKill).toMatchObject({ gotResult: true, sameSessionId: true });
    // The fake does not run hooks; the real run fills these.
    expect(report.httpHooks).toEqual([]);
    expect(report.commandHooks).toEqual([]);
  }, 90_000);
});
