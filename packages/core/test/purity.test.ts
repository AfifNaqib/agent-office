// C-04 AC: no Date.now / Math.random inside core, enforced by a lint rule.
// This test proves the rule is active on core source files.
//
// NB-01: the fake sources are linted in a CHILD process (helpers/lint-fakes.mjs).
// In-process, ESLint's typescript-eslint project service is shared, so a fake
// linted under the real avatar.ts path leaked into it and made "the real core
// sources are lint-clean" fail about 1 run in 4-8.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CORE_FILE = join(ROOT, 'packages', 'core', 'src', 'reducers', 'avatar.ts');
const LINT_FAKES = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'lint-fakes.mjs');

const CASES = [
  { name: 'Date.now()', code: 'export const t = Date.now();', rule: 'no-restricted-properties' },
  { name: 'Math.random()', code: 'export const r = Math.random();', rule: 'no-restricted-properties' },
  { name: 'new Date()', code: 'export const d = new Date();', rule: 'no-restricted-syntax' },
  { name: 'process global', code: 'export const e = process.env;', rule: 'no-restricted-globals' },
  { name: 'clean code', code: 'export const ok = (a: number): number => a + 1;', rule: null },
] as const;

let found: Record<string, string[]> = {};

beforeAll(() => {
  const stdout = execFileSync(process.execPath, [LINT_FAKES], {
    cwd: ROOT,
    input: JSON.stringify({ root: ROOT, filePath: CORE_FILE, cases: CASES.map(({ name, code }) => ({ name, code })) }),
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  found = JSON.parse(stdout) as Record<string, string[]>;
}, 60_000);

describe('core purity lint rules', () => {
  it.each(CASES.filter((c) => c.rule !== null).map((c) => [c.name, c.rule] as const))('%s is a lint error in core', (name, rule) => {
    expect(found[name]).toContain(rule);
  });

  it('clean code in core has no lint messages (the fake linting works)', () => {
    expect(found['clean code']).toEqual([]);
  });

  it('the real core sources are lint-clean', async () => {
    const eslint = new ESLint({ cwd: ROOT });
    const results = await eslint.lintFiles(['packages/core/src/**/*.ts']);
    expect(results.flatMap((r) => r.messages)).toEqual([]);
  }, 60_000);
});
