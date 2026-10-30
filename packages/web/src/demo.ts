// Scripted team run for the office view until the live client (V0-03/V0-05) exists.
// Times are seconds from the loop start; emittedAt is ms on the same clock.
import type { Actor, OfficeEvent } from '@agent-office/core';

export const DEMO_LOOP_S = 72;

const MAIN: Actor = { kind: 'main', agentType: null, agentId: null };
const sub = (type: string): Actor => ({ kind: 'subagent', agentType: type, agentId: `${type}-demo` });

type Step = [t: number, actor: Actor, kind: OfficeEvent['kind'], extra?: Partial<OfficeEvent>];

let n = 0;
const tool = (name: string, useId: string, summary = '') => ({ tool: { name, useId, summary } });

/** One tool call: start at t, end (or fail) at t + d. */
function call(t: number, a: Actor, name: string, d: number, summary = '', fail = false): Step[] {
  const id = `u${++n}`;
  return [
    [t, a, 'tool.start', tool(name, id, summary)],
    [t + d, a, fail ? 'tool.fail' : 'tool.end', { ...tool(name, id, summary), ...(fail ? { text: 'exit 1' } : {}) }],
  ];
}

/** JEBON delegates to `type`: Agent tool open around the subagent's whole run. */
function delegate(t0: number, type: string, task: string, work: (t: number, a: Actor) => Step[], len: number): Step[] {
  const a = sub(type);
  const id = `u${++n}`;
  return [
    [t0, MAIN, 'tool.start', tool('Agent', id, `${type}: ${task}`)],
    [t0 + 1, a, 'agent.start'],
    ...work(t0 + 2, a),
    [t0 + len, a, 'agent.stop', { text: 'done' }],
    [t0 + len + 1, MAIN, 'tool.end', tool('Agent', id, `${type}: ${task}`)],
  ];
}

const STEPS: Step[] = [
  [0, MAIN, 'session.start'],
  [1, MAIN, 'prompt.submit', { text: 'Build the login page' }],
  ...call(2, MAIN, 'Read', 2, 'docs/build-plan.md'),
  ...delegate(5, 'architect', 'Plan the login page', (t, a) => [...call(t, a, 'Read', 2), ...call(t + 3, a, 'WebSearch', 3), ...call(t + 7, a, 'Write', 2)], 12),
  ...delegate(19, 'coder', 'Build it', (t, a) => [
    ...call(t, a, 'Edit', 4),
    [t + 5, a, 'tool.start', tool('Bash', 'perm-bash', 'npm test')],
    [t + 6, a, 'permission.request', { permission: { requestId: 'r1', toolName: 'Bash', summary: 'npm test' } }],
    [t + 10, a, 'permission.resolved', { permission: { requestId: 'r1', toolName: 'Bash', summary: 'npm test', decision: 'allow' } }],
    [t + 13, a, 'tool.end', tool('Bash', 'perm-bash', 'npm test')],
  ], 16),
  ...delegate(37, 'tester', 'Try to break it', (t, a) => [...call(t, a, 'Bash', 2, 'npm test', true), ...call(t + 4, a, 'Bash', 3, 'npm test')], 10),
  ...delegate(49, 'manager', 'Summarize', (t, a) => call(t, a, 'Read', 3), 6),
  ...delegate(57, 'Explore', 'Find old auth code', (t, a) => call(t, a, 'Grep', 3), 6),
  [65, MAIN, 'turn.stop', { text: 'Login page shipped' }],
];

/** The demo run as OfficeEvents, sorted by time. */
export function demoEvents(): OfficeEvent[] {
  return STEPS.map(([t, actor, kind, extra], i) => ({
    v: 1 as const,
    id: `demo-${String(i).padStart(3, '0')}`,
    emittedAt: Math.round(t * 1000),
    source: 'local' as const,
    sessionId: 'demo',
    repo: 'agent-office',
    actor,
    kind,
    ...extra,
  })).sort((x, y) => x.emittedAt - y.emittedAt || x.id.localeCompare(y.id));
}
