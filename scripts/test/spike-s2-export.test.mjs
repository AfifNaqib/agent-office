import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { scrubText, truncate } from '../../packages/core/src/redact.ts';
import { exportCaptures, stripHome } from '../spike-s2-export.mjs';

const CAPTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'spike-s2-capture.mjs');
const j = (...p) => p.join('');

const dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ao-s2x-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function captureInto(dir, payload) {
  spawnSync(process.execPath, [CAPTURE, '--form', 'exec'], {
    input: JSON.stringify(payload),
    env: { ...process.env, AGENT_OFFICE_CAPTURE_DIR: dir },
  });
}

describe('spike-s2-export', () => {
  it('turns captures into scrubbed _observed fixtures', () => {
    const cap = tmp();
    const out = tmp();
    const planted = j('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
    captureInto(cap, {
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      cwd: '/home/alice/agent-office',
      tool_name: 'Bash',
      agent_type: 'tester',
      tool_input: { command: `echo ${planted}`, content: 'x'.repeat(1000) },
    });
    captureInto(cap, { hook_event_name: 'Stop', session_id: 's1', cwd: 'C:\\Users\\Alice\\agent-office' });

    const written = exportCaptures(cap, out, { scrubText, truncate });
    expect(written).toHaveLength(2);
    expect(readdirSync(out).sort()).toEqual([...written].sort());
    expect(written[0]).toMatch(/^001-PreToolUse-Bash-tester-exec\.json$/);

    const text = readFileSync(join(out, written[0]), 'utf8');
    expect(text).not.toContain(planted);
    expect(text).not.toContain('alice');
    const fx = JSON.parse(text);
    expect(fx._observed).toMatch(/^OBSERVED/);
    expect(fx._provisional).toBeUndefined();
    expect(fx.payload.cwd).toBe('~/agent-office');
    expect(fx.payload.tool_input.content.length).toBeLessThanOrEqual(200);
    expect(fx._capture.env).toBeTypeOf('object');
    expect(JSON.parse(readFileSync(join(out, written[1]), 'utf8')).payload.cwd).toBe('~\\agent-office');
  });

  it('stripHome handles Linux, macOS and Windows homes', () => {
    expect(stripHome('/home/alice/x')).toBe('~/x');
    expect(stripHome('/Users/alice/x')).toBe('~/x');
    expect(stripHome('C:\\Users\\Alice\\x')).toBe('~\\x');
    expect(stripHome('/root/x')).toBe('~/x');
    expect(stripHome('/srv/app')).toBe('/srv/app');
  });
});
