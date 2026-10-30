import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Purity rules for @agent-office/core (plan C-04: no Date.now / Math.random
// inside the core). Time and ids always come in through arguments.
const corePurity = {
  'no-restricted-properties': [
    'error',
    { object: 'Date', property: 'now', message: 'core is pure: pass time in as an argument.' },
    { object: 'Math', property: 'random', message: 'core is deterministic: no Math.random.' },
    { object: 'performance', property: 'now', message: 'core is pure: pass time in as an argument.' },
    { object: 'crypto', property: 'getRandomValues', message: 'core is deterministic.' },
    { object: 'crypto', property: 'randomUUID', message: 'core is deterministic.' },
  ],
  'no-restricted-syntax': [
    'error',
    {
      selector: "NewExpression[callee.name='Date']",
      message: 'core is pure: pass time in as an argument (no new Date()).',
    },
  ],
  'no-restricted-globals': [
    'error',
    { name: 'process', message: 'core must run in Node, Workers and browsers.' },
    { name: 'window', message: 'core must run in Node, Workers and browsers.' },
    { name: 'document', message: 'core must run in Node, Workers and browsers.' },
    { name: 'localStorage', message: 'core must run in Node, Workers and browsers.' },
  ],
};

export default defineConfig([
  globalIgnores(['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/.spike/**', '.claude/worktrees/**']),
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    rules: corePurity,
  },
]);
