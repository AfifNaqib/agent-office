import { describe, expect, it } from 'vitest';
import { EMIT_NAME, PATH_PLACEHOLDER, assertSafeEmitPath, fillTemplate, isOurHook, listOurHooks, mergeHooks, removeHooks, summarizeChange } from '../lib/hooks-merge.mjs';

const ours = (path) => ({ type: 'command', command: 'node', args: [path], async: true });
const other = { type: 'command', command: 'echo', args: ['hi'] };
const tpl = (path = '/new/agent-office-emit.mjs') => ({
  hooks: {
    Stop: [{ hooks: [ours(path)] }],
    PreToolUse: [{ matcher: '*', hooks: [ours(path)] }],
  },
});

describe('isOurHook (the stable marker)', () => {
  it('matches node + one arg ending in agent-office-emit.mjs, either slash', () => {
    expect(isOurHook(ours('/a/b/agent-office-emit.mjs'))).toBe(true);
    expect(isOurHook(ours('C:\\a b\\.agent-office\\hooks\\agent-office-emit.mjs'))).toBe(true);
    expect(isOurHook(ours('${CLAUDE_PROJECT_DIR}/.claude/hooks/agent-office-emit.mjs'))).toBe(true);
    expect(isOurHook(ours(EMIT_NAME))).toBe(true);
  });
  it('does not match look-alikes', () => {
    for (const h of [
      other,
      ours('/a/not-agent-office-emit.mjs'),
      ours('/a/agent-office-emit.mjs.bak'),
      { ...ours('/a/agent-office-emit.mjs'), command: 'bash' },
      { type: 'http', url: 'http://x/agent-office-emit.mjs' },
      { type: 'command', command: 'node', args: ['--x', '/a/agent-office-emit.mjs'] },
      { type: 'command', command: 'node /a/agent-office-emit.mjs' },
      null,
      'x',
    ]) {
      expect(isOurHook(h), JSON.stringify(h)).toBe(false);
    }
  });
});

describe('mergeHooks', () => {
  it('keeps other keys and hooks, adds ours (new event, existing event)', () => {
    const s = { model: 'opus', permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [other] }], Other: [{ hooks: [other] }] } };
    const m = mergeHooks(s, tpl());
    expect(m.model).toBe('opus');
    expect(m.permissions).toEqual(s.permissions);
    expect(m.hooks.Other).toEqual(s.hooks.Other);
    expect(m.hooks.Stop).toEqual([{ hooks: [other] }, ...tpl().hooks.Stop]);
    expect(m.hooks.PreToolUse).toEqual(tpl().hooks.PreToolUse);
    expect(s.hooks.Stop).toEqual([{ hooks: [other] }]); // input not mutated
  });

  it('works on settings with no hooks key', () => {
    expect(mergeHooks({ a: 1 }, tpl())).toEqual({ a: 1, hooks: tpl().hooks });
  });

  it('is idempotent and replaces an old copy at a moved path, in place', () => {
    const start = { hooks: { Stop: [{ hooks: [other, ours('C:\\old\\agent-office-emit.mjs')] }, { hooks: [other] }] } };
    const once = mergeHooks(start, tpl());
    expect(once.hooks.Stop).toEqual([...tpl().hooks.Stop, { hooks: [other] }, { hooks: [other] }]);
    expect(mergeHooks(once, tpl())).toEqual(once);
    expect(JSON.stringify(mergeHooks(once, tpl()))).toBe(JSON.stringify(once));
  });

  it('a hook the user added AFTER ours stays after ours on re-run (no reordering churn)', () => {
    const once = mergeHooks({}, tpl());
    once.hooks.Stop.push({ hooks: [other] });
    expect(mergeHooks(once, tpl())).toEqual(once);
  });

  it('never produces two copies, even from a file that already has duplicates', () => {
    const dup = { hooks: { Stop: [{ hooks: [ours('/a/agent-office-emit.mjs')] }, { hooks: [ours('/b/agent-office-emit.mjs')] }] } };
    expect(listOurHooks(mergeHooks(dup, tpl()))).toEqual(['PreToolUse [*] -> /new/agent-office-emit.mjs', 'Stop -> /new/agent-office-emit.mjs']);
  });

  it('removes our hook from an event the template no longer has', () => {
    const m = mergeHooks({ hooks: { Gone: [{ hooks: [ours('/a/agent-office-emit.mjs')] }] } }, tpl());
    expect(m.hooks.Gone).toBeUndefined();
  });

  it('refuses a hooks value of the wrong shape instead of overwriting it', () => {
    expect(() => mergeHooks({ hooks: [] }, tpl())).toThrow(/not an object/);
    expect(() => mergeHooks({ hooks: 'x' }, tpl())).toThrow(/not an object/);
    expect(() => mergeHooks({ hooks: { Stop: 'x' } }, tpl())).toThrow(/hooks\.Stop.*not a list/);
  });
});

describe('removeHooks', () => {
  it('removes only ours', () => {
    const m = mergeHooks({ model: 'x', hooks: { Stop: [{ hooks: [other] }], Other: [{ hooks: [other] }] } }, tpl());
    expect(removeHooks(m)).toEqual({ model: 'x', hooks: { Stop: [{ hooks: [other] }], Other: [{ hooks: [other] }] } });
  });
  it('a mixed group keeps the other hooks and its matcher', () => {
    const s = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [other, ours('/a/agent-office-emit.mjs')] }] } };
    expect(removeHooks(s)).toEqual({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [other] }] } });
  });
  it('drops the hooks key when only ours were in it, and leaves a hooks key that was already empty', () => {
    expect(removeHooks(mergeHooks({ model: 'x' }, tpl()))).toEqual({ model: 'x' });
    expect(removeHooks({ hooks: {} })).toEqual({ hooks: {} });
    expect(removeHooks({ a: 1 })).toEqual({ a: 1 });
  });
});

describe('assertSafeEmitPath', () => {
  it('allows spaces, backslashes, drive letters and POSIX paths', () => {
    for (const p of ['C:\\Users\\Po Po\\.agent-office\\hooks\\agent-office-emit.mjs', '/home/a b/.agent-office/hooks/agent-office-emit.mjs', '\\\\server\\share\\x\\agent-office-emit.mjs']) {
      expect(() => assertSafeEmitPath(p), p).not.toThrow();
    }
  });
  it.each(['$', '%', '`', '"', '\n', '\r', '\0'])('refuses %j with a readable message', (ch) => {
    expect(() => assertSafeEmitPath(`C:\\Users\\a${ch}b\\agent-office-emit.mjs`)).toThrow(/character .* that a hook shell would expand/);
  });
  it('refuses relative and non-string paths', () => {
    expect(() => assertSafeEmitPath('hooks/agent-office-emit.mjs')).toThrow(/absolute/);
    expect(() => assertSafeEmitPath(undefined)).toThrow(/absolute/);
  });
});

describe('fillTemplate', () => {
  it('replaces the placeholder everywhere and a backslash path survives a JSON round trip', () => {
    const p = 'C:\\Users\\Po Po\\.agent-office\\hooks\\agent-office-emit.mjs';
    const filled = fillTemplate({ hooks: { A: [{ hooks: [{ args: [PATH_PLACEHOLDER] }] }] } }, p);
    expect(filled.hooks.A[0].hooks[0].args).toEqual([p]);
    expect(JSON.parse(JSON.stringify(filled))).toEqual(filled);
  });
});

describe('summarizeChange', () => {
  it('lists added and removed lines, nothing when equal', () => {
    const a = {};
    const b = mergeHooks(a, tpl());
    expect(summarizeChange(a, b)).toEqual(['+ PreToolUse [*] -> /new/agent-office-emit.mjs', '+ Stop -> /new/agent-office-emit.mjs']);
    expect(summarizeChange(b, a)).toEqual(['- PreToolUse [*] -> /new/agent-office-emit.mjs', '- Stop -> /new/agent-office-emit.mjs']);
    expect(summarizeChange(b, b)).toEqual([]);
  });
});
