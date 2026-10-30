#!/usr/bin/env node
// Spike S2: turn raw captures (from spike-s2-capture.mjs) into scrubbed fixtures.
//
//   npm run build -w @agent-office/core
//   node scripts/spike-s2-export.mjs <captureDir> <outDir>
//   e.g. node scripts/spike-s2-export.mjs .spike/s2/win32 fixtures/hooks/pc
//
// Every string value goes through core's scrubText, is cut to 200 chars, and has
// home-directory prefixes replaced with "~". Keys and structure are kept so the
// fixtures still show the real payload shape. The PO must still review the
// output before committing: this is a safety net, not a guarantee.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isMain } from './lib/is-main.mjs';

const MAX_STRING = 200;
const HOME_PATTERNS = [
  /\/home\/[^/\s"]+/g,
  /\/Users\/[^/\s"]+/g,
  /[A-Za-z]:\\\\?Users\\\\?[^\\\s"]+/gi,
  /\/root(?=\/|$)/g,
];

export function stripHome(s) {
  return HOME_PATTERNS.reduce((acc, re) => acc.replace(re, '~'), s);
}

export function scrubDeep(value, redact) {
  if (typeof value === 'string') return redact.truncate(redact.scrubText(stripHome(value)), MAX_STRING);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, redact));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v, redact)]));
  }
  return value;
}

function safePart(s) {
  return String(s ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
}

/** Returns the list of written file names. */
export function exportCaptures(captureDir, outDir, redact) {
  const records = readdirSync(captureDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(captureDir, f), 'utf8')))
    .filter((r) => r && r.capture && typeof r.stdinRaw === 'string')
    .sort((a, b) => a.capture.capturedAtMs - b.capture.capturedAtMs);

  mkdirSync(outDir, { recursive: true });
  const written = [];
  records.forEach((r, i) => {
    let payload;
    try {
      payload = JSON.parse(r.stdinRaw);
    } catch {
      return; // unparseable stdin: nothing to learn from as a fixture
    }
    const c = r.capture;
    const fixture = {
      _observed: `OBSERVED – exported from an S2 capture (${c.platform}), scrubbed`,
      _capture: {
        platform: c.platform,
        form: c.form,
        node: c.node,
        bootMs: c.bootMs,
        env: c.env,
        remoteSessionIdShape: c.remoteSessionIdShape,
        projectDirBasename: c.projectDirBasename,
      },
      payload: scrubDeep(payload, redact),
    };
    const name = [
      String(i + 1).padStart(3, '0'),
      safePart(payload.hook_event_name),
      safePart(payload.tool_name),
      safePart(payload.agent_type),
      safePart(c.form),
    ]
      .filter(Boolean)
      .join('-');
    writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
    written.push(`${name}.json`);
  });
  return written;
}

async function main() {
  const [captureDir, outDir] = process.argv.slice(2);
  if (!captureDir || !outDir) {
    console.error('usage: node scripts/spike-s2-export.mjs <captureDir> <outDir>');
    process.exit(2);
  }
  let core;
  try {
    core = await import('../packages/core/dist/index.js');
  } catch {
    console.error('Build core first: npm run build -w @agent-office/core');
    process.exit(2);
  }
  const written = exportCaptures(resolve(captureDir), resolve(outDir), core);
  console.log(`wrote ${written.length} fixtures to ${outDir}`);
  console.log('Review every file before committing. Raw captures stay in .spike/ (never commit).');
}

if (isMain(import.meta.url)) await main();
