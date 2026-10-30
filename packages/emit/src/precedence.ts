// FR-004: the repo copy of the hook wins over the user-level copy.
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Env } from './destination.js';

export const REPO_COPY = join('.claude', 'hooks', 'agent-office-emit.mjs');

function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const x = real(a);
  const y = real(b);
  return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * True when this script is NOT the repo copy but the repo has one, so this
 * (user-level) copy must exit and leave the sending to the repo copy. With no
 * CLAUDE_PROJECT_DIR, or no repo copy, this copy sends.
 */
export function shouldYieldToRepoCopy(env: Env, selfPath: string, platform: NodeJS.Platform = process.platform): boolean {
  const project = env.CLAUDE_PROJECT_DIR;
  if (!project) return false;
  const repoCopy = join(project, REPO_COPY);
  return existsSync(repoCopy) && !samePath(repoCopy, selfPath, platform);
}
