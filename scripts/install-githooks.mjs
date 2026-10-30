#!/usr/bin/env node
// Runs on `npm install` / `npm ci` (the "prepare" script). Points git at the
// committed .githooks/ folder so the pre-commit secret scan runs locally.
// Never fails the install: any problem is a silent no-op.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

try {
  if (!process.env.CI && existsSync(join(root, '.git')) && existsSync(join(root, '.githooks'))) {
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'ignore' });
  }
} catch {
  // git missing or not a repo: nothing to do.
}
