#!/usr/bin/env node
// Simple regex secret scanner (plan §11 "Secrets"). Runs in CI and pre-commit.
//
// Usage:
//   node scripts/secret-scan.mjs                 scan tracked + untracked (not ignored) files
//   node scripts/secret-scan.mjs --staged        scan the staged versions of staged files
//   node scripts/secret-scan.mjs --root <dir>    scan another directory (git-aware if it is a repo)
//   node scripts/secret-scan.mjs <file>...       scan only these files
//
// Exit codes: 0 = clean, 1 = findings, 2 = usage/internal error.
// Findings never print the matched value, only file, line and rule name.
//
// There is deliberately no allowlist. Tests that need planted secrets build them
// at runtime (string concatenation), so the source never contains a literal match.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { isMain } from './lib/is-main.mjs';

export const RULES = [
  { name: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{16,}/ },
  { name: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/ },
  { name: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  {
    name: 'quoted-secret-assignment',
    // key = "value" / key: 'value' with a literal value of 16+ chars.
    // Values that are references ($VAR, ${VAR}, <placeholder>) are not secrets.
    re: /[\w-]*(?:password|passwd|secret|token|api[_-]?key)["']?\s*[:=]\s*["'](?![$<{])[^"'\s]{16,}["']/i,
  },
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.spike']);
const MAX_BYTES = 5 * 1024 * 1024;

/** Scan one text blob. Returns findings without the secret value. */
export function scanText(text, file) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) findings.push({ file, line: i + 1, rule: rule.name });
    }
  });
  return findings;
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] });
}

function isGitRepo(root) {
  try {
    return git(root, ['rev-parse', '--is-inside-work-tree']).toString().trim() === 'true';
  } catch {
    return false;
  }
}

function splitZ(buf) {
  return buf.toString('utf8').split('\0').filter(Boolean);
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** Returns [{ file, read: () => Buffer }] for the requested scope. */
function collect(root, { staged, files }) {
  if (files.length > 0) {
    return files.map((f) => ({ file: f, read: () => readFileSync(resolve(f)) }));
  }
  if (staged) {
    const names = splitZ(git(root, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']));
    return names.map((f) => ({ file: f, read: () => git(root, ['show', `:${f}`]) }));
  }
  if (isGitRepo(root)) {
    const names = splitZ(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']));
    return names
      .filter((f) => existsSync(join(root, f)))
      .map((f) => ({ file: f, read: () => readFileSync(join(root, f)) }));
  }
  return walk(root, []).map((abs) => ({ file: relative(root, abs), read: () => readFileSync(abs) }));
}

export function scan({ root = process.cwd(), staged = false, files = [] } = {}) {
  const findings = [];
  let scanned = 0;
  for (const { file, read } of collect(root, { staged, files })) {
    let buf;
    try {
      buf = read();
    } catch {
      continue;
    }
    if (buf.length > MAX_BYTES || isBinary(buf)) continue;
    scanned++;
    findings.push(...scanText(buf.toString('utf8'), file));
  }
  return { scanned, findings };
}

function parseArgs(argv) {
  const opts = { root: process.cwd(), staged: false, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--staged') opts.staged = true;
    else if (a === '--root') {
      const v = argv[++i];
      if (!v) throw new Error('--root needs a directory');
      opts.root = resolve(v);
    } else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else opts.files.push(a);
  }
  if (!existsSync(opts.root) || !statSync(opts.root).isDirectory()) {
    throw new Error(`not a directory: ${opts.root}`);
  }
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`secret-scan: ${err.message}`);
    process.exit(2);
  }
  const { scanned, findings } = scan(opts);
  if (findings.length === 0) {
    console.log(`secret-scan: ${scanned} files clean`);
    return;
  }
  for (const f of findings) console.error(`secret-scan: ${f.file}:${f.line}: possible secret (${f.rule})`);
  console.error(`secret-scan: ${findings.length} finding(s) in ${scanned} files. Remove the secret; never commit it.`);
  process.exit(1);
}

if (isMain(import.meta.url)) main();
