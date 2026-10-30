import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OfficeEventSchema } from '@agent-office/core';
import { buildTeamRun, readTeamRun, TEAM_RUN_PATH, toJsonl } from './helpers/team-run.js';

describe('fixtures/sessions/team-run.jsonl', () => {
  it('is regenerated from the observed hook fixtures (UPDATE_FIXTURES=1 rewrites it)', async () => {
    const built = toJsonl(await buildTeamRun());
    if (process.env.UPDATE_FIXTURES) writeFileSync(TEAM_RUN_PATH, built);
    expect(toJsonl(readTeamRun())).toBe(built);
  });

  it('holds valid OfficeEvents in time order for one session with main, architect and tester', () => {
    const events = readTeamRun();
    expect(events.length).toBeGreaterThan(20);
    for (const e of events) expect(OfficeEventSchema.safeParse(e).success).toBe(true);
    expect(events.map((e) => e.emittedAt)).toEqual([...events.map((e) => e.emittedAt)].sort((a, b) => a - b));
    expect(new Set(events.map((e) => e.sessionId)).size).toBe(1);
    expect(new Set(events.flatMap((e) => (e.actor.agentType ? [e.actor.agentType] : [])))).toEqual(new Set(['architect', 'tester']));
    expect(events.some((e) => e.kind === 'permission.request')).toBe(true);
    const bash = events.filter((e) => e.actor.agentType === 'tester' && e.tool?.name === 'Bash');
    expect((bash[1]?.emittedAt ?? 0) - (bash[0]?.emittedAt ?? 0)).toBeGreaterThanOrEqual(12_000);
  });
});
