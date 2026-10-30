// Builds fixtures/sessions/team-run.jsonl from the OBSERVED hook fixtures, through
// the real normalize() path (nothing here invents an event shape).
//
// Source: fixtures/hooks/pc (main + architect + tester, a long tester Bash call)
// plus the permission segment of fixtures/hooks/pc2 (Bash -> PermissionRequest ->
// Notification -> PostToolUseFailure), moved into the same session. Times are
// assigned here: 1 s apart, a tool.end that carries duration_ms is no earlier than
// its start + duration, and the permission card waits PERMISSION_HOLD_MS.
// Regenerate: UPDATE_FIXTURES=1 npx vitest run packages/web/test/team-run.test.ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint, normalize, type OfficeEvent } from '@agent-office/core';
import { loadFixtures, type HookFixture } from '../../../core/test/helpers/fixtures.js';

export const TEAM_RUN_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'fixtures', 'sessions', 'team-run.jsonl');
export const TEAM_RUN_T0 = 1_760_000_000_000;
export const STEP_MS = 1_000;
export const PERMISSION_HOLD_MS = 8_000;
/** The pc2 files used for the permission segment (all exec form, no duplicates). */
const PERMISSION_FILES = ['007-PreToolUse-Bash-exec.json', '008-PermissionRequest-Bash-exec.json', '009-Notification-exec.json', '010-PostToolUseFailure-Bash-exec.json'];

export async function buildTeamRun(): Promise<OfficeEvent[]> {
  const all = loadFixtures();
  const pc = all.filter((f) => f.set === 'pc' && f.observed);
  const sessionId = pc[0]?.payload.session_id;
  if (typeof sessionId !== 'string') throw new Error('pc fixtures expected');
  const perm = PERMISSION_FILES.map((name) => {
    const f = all.find((x) => x.set === 'pc2' && x.file === name);
    if (!f) throw new Error(`pc2/${name} missing`);
    return { ...f, payload: { ...f.payload, session_id: sessionId } } satisfies HookFixture;
  });
  // The permission segment goes between the last hand-back prompt (031) and its Stop (033).
  const stopAt = pc.findIndex((f) => f.file.startsWith('033-'));
  const ordered = [...pc.slice(0, stopAt), ...perm, ...pc.slice(stopAt)];

  const out: OfficeEvent[] = [];
  const startedAt = new Map<string, number>();
  const seen = new Set<string>();
  let cursor = TEAM_RUN_T0 - STEP_MS;
  for (const f of ordered) {
    const id = await fingerprint('local', JSON.stringify(f.payload));
    const e = normalize(f.payload, { id, emittedAt: 0, source: 'local' });
    if (!e || seen.has(e.id)) continue; // ignored hook, or the shell form of an event already seen
    seen.add(e.id);
    let at = cursor + STEP_MS;
    if (e.tool?.useId !== undefined && e.kind === 'tool.start') startedAt.set(e.tool.useId, at);
    const dur = e.tool?.durationMs;
    const began = e.tool?.useId === undefined ? undefined : startedAt.get(e.tool.useId);
    if (e.kind === 'tool.end' && dur !== undefined && began !== undefined) at = Math.max(at, began + dur);
    if (e.kind === 'tool.fail' && f.set === 'pc2') at += PERMISSION_HOLD_MS;
    cursor = at;
    out.push({ ...e, emittedAt: at });
  }
  return out;
}

export const toJsonl = (events: readonly OfficeEvent[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

export function readTeamRun(): OfficeEvent[] {
  return readFileSync(TEAM_RUN_PATH, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as OfficeEvent);
}
