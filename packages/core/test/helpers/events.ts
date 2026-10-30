// Test-only builders for OfficeEvents.
import type { Actor, EventKind, OfficeEvent } from '../../src/schema.js';

export const MAIN: Actor = { kind: 'main', agentType: null, agentId: null };
export const ARCH: Actor = { kind: 'subagent', agentType: 'architect', agentId: 'agent-arch' };
export const CODER: Actor = { kind: 'subagent', agentType: 'coder', agentId: 'agent-code' };
export const TESTER: Actor = { kind: 'subagent', agentType: 'tester', agentId: 'agent-test' };
export const EXPLORE: Actor = { kind: 'subagent', agentType: 'Explore', agentId: 'agent-expl' };

export function hexId(n: number): string {
  return n.toString(16).padStart(64, '0');
}

let counter = 0;

/** Build a valid event for `kind`, filling the fields that kind requires. */
export function ev(kind: EventKind, over: Partial<OfficeEvent> = {}): OfficeEvent {
  counter += 1;
  const base: OfficeEvent = {
    v: 1,
    id: hexId(counter),
    emittedAt: 1_000_000 + counter,
    source: 'local',
    sessionId: 's1',
    actor: MAIN,
    kind,
  };
  if (kind === 'tool.start' || kind === 'tool.end' || kind === 'tool.fail') {
    base.tool = { name: 'Read', useId: `toolu_${counter}`, summary: 'a/b.ts' };
  }
  if (kind === 'permission.request') base.permission = { requestId: `req_${counter}`, toolName: 'Bash', summary: 'rm -rf' };
  if (kind === 'permission.resolved') {
    base.permission = { requestId: `req_${counter}`, toolName: 'Bash', summary: 'rm -rf', decision: 'allow' };
  }
  if (kind === 'run.status') base.run = { status: 'running' };
  return { ...base, ...over };
}

/** A sequence of events with strictly increasing emittedAt starting at t0, step ms apart. */
export function timeline(t0: number, step: number, events: OfficeEvent[]): OfficeEvent[] {
  return events.map((e, i) => ({ ...e, emittedAt: t0 + i * step }));
}

export function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}
