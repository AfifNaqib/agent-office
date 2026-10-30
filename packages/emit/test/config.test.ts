// hooks-config templates: exec form, every FR-001 event, async, no secrets.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOOK_KIND } from '@agent-office/core';
import { PKG } from './helpers.js';

const DIR = join(PKG, '..', '..', 'hooks-config');
interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string; args?: string[]; async?: boolean }[];
}
const load = (f: string): { hooks: Record<string, HookEntry[]> } =>
  JSON.parse(readFileSync(join(DIR, f), 'utf8')) as { hooks: Record<string, HookEntry[]> };

describe.each([
  ['repo-settings.json', '${CLAUDE_PROJECT_DIR}/.claude/hooks/agent-office-emit.mjs'],
  ['user-settings.json', '__AGENT_OFFICE_EMIT_PATH__'],
])('%s', (file, arg) => {
  const cfg = load(file);

  it('has exactly the FR-001 events', () => {
    expect(Object.keys(cfg.hooks).sort()).toEqual(Object.keys(HOOK_KIND).sort());
  });

  it('every hook is an async exec-form command: node + [script]', () => {
    for (const [event, entries] of Object.entries(cfg.hooks)) {
      expect(entries, event).toHaveLength(1);
      expect(entries[0]?.hooks, event).toEqual([{ type: 'command', command: 'node', args: [arg], async: true }]);
    }
  });

  it('tool and permission events use matcher "*", the others none', () => {
    const withMatcher = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);
    for (const [event, entries] of Object.entries(cfg.hooks)) {
      expect(entries[0]?.matcher, event).toBe(withMatcher.has(event) ? '*' : undefined);
    }
  });

  it('has no http hook, no token and no onFailure (PermissionRequest http hook is V2)', () => {
    const text = readFileSync(join(DIR, file), 'utf8');
    expect(text).not.toMatch(/"type": "http"|onFailure|token|Bearer|password/i);
  });
});
