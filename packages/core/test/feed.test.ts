import { describe, expect, it } from 'vitest';
import {
  DONE_MAX,
  GROUP_AFTER,
  MAX_FEED_ITEMS,
  MAX_TRACKED,
  groupText,
  initialFeedState,
  plainText,
  reduceFeed,
  toolCategory,
  type FeedGroup,
  type FeedItem,
  type FeedPermission,
  type FeedState,
} from '../src/reducers/feed.js';
import { EVENT_KINDS, type Actor, type OfficeEvent, type ToolInfo } from '../src/schema.js';
import { ARCH, CODER, EXPLORE, MAIN, TESTER, deepFreeze, ev } from './helpers/events.js';
import { fixtureTimeline } from './helpers/fixtures.js';

const T = 20_000_000;
let n = 0;
const feed = (...events: OfficeEvent[]): FeedState => events.reduce(reduceFeed, initialFeedState());
const tool = (name: string, summary = '', useId?: string): ToolInfo => (useId ? { name, summary, useId } : { name, summary });
const start = (actor: Actor, name: string, summary = 'x') =>
  ev('tool.start', { actor, emittedAt: T + ++n, tool: tool(name, summary, `u${n}`) });
const texts = (s: FeedState) => s.items.map((i) => (i.type === 'permission' ? `[perm ${i.status}]` : i.text));

describe('tool lines and grouping (FR-009)', () => {
  it(`up to ${GROUP_AFTER} consecutive tool lines from one actor stay separate`, () => {
    const s = feed(start(CODER, 'Edit', 'src/a.ts'), start(CODER, 'Edit', 'src/b.ts'), start(CODER, 'Bash', 'npm test'));
    expect(texts(s)).toEqual(['Edit src/a.ts', 'Edit src/b.ts', 'Bash npm test']);
    expect(s.items.every((i) => i.type === 'line' && i.actorLabel === 'coder')).toBe(true);
  });

  it('the 4th consecutive tool line collapses the run into one grouped line', () => {
    const s = feed(start(CODER, 'Edit'), start(CODER, 'Write'), start(CODER, 'Bash'), start(CODER, 'NotebookEdit'));
    expect(s.items).toHaveLength(1);
    const g = s.items[0] as FeedGroup;
    expect(g).toMatchObject({ type: 'group', actorKey: 'coder', total: 4, counts: { edit: 3, command: 1 } });
    expect(g.text).toBe('coder: 3 edits, 1 command');
  });

  it('the plan example: "coder: 4 edits, 1 command"', () => {
    const s = feed(start(CODER, 'Edit'), start(CODER, 'Edit'), start(CODER, 'Bash'), start(CODER, 'Edit'), start(CODER, 'Edit'));
    expect(texts(s)).toEqual(['coder: 4 edits, 1 command']);
  });

  it('later tools from the same actor keep growing the group; its id and time stay those of the first', () => {
    const first = start(TESTER, 'Read');
    const s = feed(first, start(TESTER, 'Grep'), start(TESTER, 'Glob'), start(TESTER, 'Read'), start(TESTER, 'WebFetch'));
    expect(s.items).toEqual([
      expect.objectContaining({ id: `group:${first.id}`, at: first.emittedAt, total: 5, text: 'tester: 2 reads, 2 searches, 1 fetch' }),
    ]);
  });

  it('another actor in between breaks the run (not consecutive)', () => {
    const s = feed(start(CODER, 'Edit'), start(CODER, 'Edit'), start(ARCH, 'Read'), start(CODER, 'Edit'), start(CODER, 'Edit'));
    expect(s.items.map((i) => i.type)).toEqual(['line', 'line', 'line', 'line', 'line']);
  });

  it('a non-tool line breaks the run; a new run starts counting from zero', () => {
    const s = feed(
      start(CODER, 'Edit'),
      start(CODER, 'Edit'),
      start(CODER, 'Edit'),
      start(CODER, 'Edit'),
      ev('notification', { actor: CODER, emittedAt: T + ++n, text: 'hi' }),
      start(CODER, 'Bash'),
      start(CODER, 'Bash'),
    );
    expect(texts(s)).toEqual(['coder: 4 edits', 'hi', 'Bash x', 'Bash x']);
  });

  it('matched tool.end adds nothing and does not break a run', () => {
    const a = start(CODER, 'Edit');
    const s = feed(a, ev('tool.end', { actor: CODER, emittedAt: T + ++n, tool: a.tool }), start(CODER, 'Edit'), start(CODER, 'Edit'), start(CODER, 'Edit'));
    expect(texts(s)).toEqual(['coder: 4 edits']);
    expect(s.openToolIds).toHaveLength(3);
  });

  it('tool.end with no start is an instant tool line (FR-010)', () => {
    const s = feed(ev('tool.end', { actor: CODER, emittedAt: T, tool: tool('Bash', 'npm run', 'late') }));
    expect(texts(s)).toEqual(['Bash npm run']);
  });

  it('mixed categories, MCP tools and pluralisation', () => {
    expect(toolCategory('mcp__github__get_me')).toBe('tool call');
    expect(groupText('JEBON', { 'tool call': 2, 'web search': 1, delegation: 1 })).toBe('JEBON: 1 web search, 1 delegation, 2 tool calls');
    expect(groupText('x', { search: 1, fetch: 3 })).toBe('x: 1 search, 3 fetches');
  });
});

describe('starting / done lines', () => {
  it('Agent tool.start is not a tool line; it supplies the "starting: <description>" of the subagent', () => {
    const s = feed(
      ev('tool.start', { emittedAt: T, tool: tool('Agent', 'architect: Review the build plan', 'ag1') }),
      ev('agent.start', { actor: ARCH, emittedAt: T + 1 }),
    );
    expect(s.items).toEqual([expect.objectContaining({ type: 'line', kind: 'starting', actorLabel: 'architect', text: 'starting: Review the build plan' })]);
    expect(s.pendingDelegations).toEqual([]);
  });

  it('agent.start without a matching delegation says just "starting"; visitors are labelled by type', () => {
    const s = feed(ev('tool.start', { emittedAt: T, tool: tool('Agent', 'coder: Build it', 'ag') }), ev('agent.start', { actor: EXPLORE, emittedAt: T + 1 }));
    expect(s.items).toEqual([expect.objectContaining({ actorKey: 'visitor:Explore', actorLabel: 'Explore', text: 'starting' })]);
    expect(s.pendingDelegations).toEqual(['coder: Build it']);
  });

  it('a delegation with no description matches by type', () => {
    const s = feed(ev('tool.start', { emittedAt: T, tool: tool('Agent', 'tester', 'ag') }), ev('agent.start', { actor: TESTER, emittedAt: T + 1 }));
    expect(texts(s)).toEqual(['starting']);
    expect(s.pendingDelegations).toEqual([]);
  });

  it(`agent.stop and turn.stop -> "done: <summary≤${DONE_MAX}>"`, () => {
    const long = 'z'.repeat(400);
    const s = feed(ev('agent.stop', { actor: ARCH, emittedAt: T, text: long }), ev('turn.stop', { emittedAt: T + 1 }));
    const [a, b] = texts(s);
    expect(a?.startsWith('done: z')).toBe(true);
    expect(a?.length).toBe('done: '.length + DONE_MAX);
    expect(a?.endsWith('…')).toBe(true);
    expect(b).toBe('done');
    expect(s.items[1]).toMatchObject({ actorLabel: 'JEBON' });
  });

  it('Agent tool.end (matched or not) adds no line', () => {
    const s = feed(ev('tool.end', { emittedAt: T, tool: tool('Agent', 'architect: x', 'nope') }));
    expect(s.items).toEqual([]);
  });
});

describe('permission cards', () => {
  const req = (requestId: string, runId?: string) =>
    ev('permission.request', {
      actor: CODER,
      emittedAt: T + ++n,
      permission: { requestId, toolName: 'Bash', summary: 'rm -rf' },
      ...(runId ? { runId } : {}),
    });
  const resolved = (requestId: string, decision: 'allow' | 'deny' | 'expired') =>
    ev('permission.resolved', { actor: CODER, emittedAt: T + ++n, permission: { requestId, toolName: 'Bash', summary: 'rm -rf', decision } });

  it('request creates a pending card; resolved updates it in place', () => {
    const s = feed(req('r1', 'run_1'));
    expect(s.items).toEqual([
      { type: 'permission', id: 'perm:r1', at: s.items[0]?.at, actorKey: 'coder', actorLabel: 'coder', requestId: 'r1', toolName: 'Bash', summary: 'rm -rf', status: 'pending', runId: 'run_1', actionable: true },
    ]);
    for (const d of ['allow', 'deny', 'expired'] as const) {
      const r = reduceFeed(s, resolved('r1', d));
      expect(r.items).toHaveLength(1);
      expect((r.items[0] as FeedPermission).status).toBe(d);
    }
  });

  it('a card is not created twice and a decided card is not re-decided', () => {
    const s = feed(req('r2'), req('r2'), resolved('r2', 'deny'), resolved('r2', 'allow'));
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ status: 'deny', runId: null });
  });

  it('resolved for an unknown request changes nothing', () => {
    const s = feed(req('r3'));
    expect(reduceFeed(s, resolved('other', 'allow')).items).toEqual(s.items);
  });

  it('a card breaks a tool run', () => {
    const s = feed(start(CODER, 'Edit'), start(CODER, 'Edit'), req('r4'), start(CODER, 'Edit'), start(CODER, 'Edit'));
    expect(s.items.map((i) => i.type)).toEqual(['line', 'line', 'permission', 'line', 'line']);
  });
});

describe('other kinds', () => {
  it('every kind produces the documented item (or none)', () => {
    const s = feed(
      ev('session.start', { emittedAt: T }),
      ev('prompt.submit', { emittedAt: T + 1, text: 'Plan the thing' }),
      ev('prompt.submit', { emittedAt: T + 2 }),
      ev('notification', { emittedAt: T + 3, text: 'Claude needs your permission to use Bash' }),
      ev('notification', { emittedAt: T + 4 }),
      ev('tool.fail', { actor: TESTER, emittedAt: T + 5, tool: tool('Bash', 'node -e', 'f1'), text: 'Exit code 3' }),
      ev('turn.error', { emittedAt: T + 6, text: 'rate_limit' }),
      ev('turn.error', { emittedAt: T + 7 }),
      ev('run.status', { emittedAt: T + 8, run: { status: 'exited', exitCode: 0 } }),
      ev('run.status', { emittedAt: T + 9, run: { status: 'starting' } }),
      ev('session.end', { emittedAt: T + 10 }),
    );
    expect(s.items.map((i) => [i.type === 'line' ? i.kind : i.type, i.actorLabel, i.type === 'permission' ? '' : i.text])).toEqual([
      ['session', 'JEBON', 'session started'],
      ['prompt', 'PO', 'Plan the thing'],
      ['notification', 'JEBON', 'Claude needs your permission to use Bash'],
      ['error', 'tester', 'Bash node -e failed (Exit code 3)'],
      ['error', 'JEBON', 'error: rate_limit'],
      ['error', 'JEBON', 'error'],
      ['run', 'JEBON', 'run exited (exit 0)'],
      ['run', 'JEBON', 'run starting'],
      ['session', 'JEBON', 'session ended'],
    ]);
  });

  it('tool.fail closes the open tool id', () => {
    const a = start(CODER, 'Bash');
    const s = feed(a, ev('tool.fail', { actor: CODER, emittedAt: T + ++n, tool: a.tool }));
    expect(s.openToolIds).toEqual([]);
    expect(texts(s)).toEqual(['Bash x', 'Bash x failed']);
  });

  it('session.end clears bookkeeping', () => {
    const s = feed(start(CODER, 'Bash'), ev('tool.start', { emittedAt: T + ++n, tool: tool('Agent', 'coder: x', 'ag') }), ev('session.end', { emittedAt: T + ++n }));
    expect(s).toMatchObject({ openToolIds: [], pendingDelegations: [] });
  });
});

describe('plain text only (§11 XSS)', () => {
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>&amp;';

  it('input markup is kept as literal characters, not escaped and not wrapped in HTML', () => {
    const s = feed(
      ev('prompt.submit', { emittedAt: T, text: evil }),
      ev('tool.start', { actor: CODER, emittedAt: T + 1, tool: tool('Edit', evil, 'x1') }),
      ev('agent.stop', { actor: ARCH, emittedAt: T + 2, text: evil }),
    );
    expect(texts(s)).toEqual([evil, `Edit ${evil}`, `done: ${evil}`]);
  });

  it('the reducer itself never produces markup or entities', () => {
    const events = EVENT_KINDS.map((k, i) => ev(k, { actor: i % 2 ? CODER : EXPLORE, emittedAt: T + i, text: 'plain' }));
    const all = JSON.stringify(feed(...events));
    expect(all).not.toMatch(/[<>]|&[a-z]+;|&#/i);
  });

  it('control and bidi-override characters are removed', () => {
    expect(plainText('a‮b\u0007c⁦d\te\nf\u0000')).toBe('abcd\te\nf');
    const s = feed(ev('notification', { emittedAt: T, text: 'ok‮gnp.exe' }));
    expect(texts(s)).toEqual(['okgnp.exe']);
  });
});

describe('bounds and purity', () => {
  it(`keeps at most ${MAX_FEED_ITEMS} items (oldest dropped)`, () => {
    const events = Array.from({ length: MAX_FEED_ITEMS + 20 }, (_, i) => ev('notification', { emittedAt: T + i, text: `n${i}` }));
    const s = feed(...events);
    expect(s.items).toHaveLength(MAX_FEED_ITEMS);
    expect((s.items[0] as { text: string }).text).toBe('n20');
  });

  it(`bookkeeping lists stay ≤ ${MAX_TRACKED}`, () => {
    const events: OfficeEvent[] = [];
    for (let i = 0; i < MAX_TRACKED + 10; i++) {
      events.push(ev('tool.start', { actor: i % 2 ? CODER : ARCH, emittedAt: T + i, tool: tool('Read', '', `r${i}`) }));
      events.push(ev('tool.start', { emittedAt: T + i, tool: tool('Agent', `x${i}: y`, `a${i}`) }));
    }
    const s = feed(...events);
    expect(s.openToolIds.length).toBeLessThanOrEqual(MAX_TRACKED);
    expect(s.pendingDelegations.length).toBeLessThanOrEqual(MAX_TRACKED);
  });

  it('never mutates input and is deterministic', () => {
    const events = EVENT_KINDS.map((k, i) => deepFreeze(ev(k, { actor: [MAIN, CODER, EXPLORE][i % 3] ?? MAIN, emittedAt: T + i })));
    let cur: FeedState = deepFreeze(initialFeedState());
    expect(() => {
      for (const e of events) cur = deepFreeze(reduceFeed(cur, e));
    }).not.toThrow();
    expect(events.reduce(reduceFeed, initialFeedState())).toEqual(cur);
  });
});

// Uses fixtures/hooks/provisional: PROVISIONAL – from docs, not observed.
describe('fixture replay (provisional fixtures)', () => {
  it('produces the expected feed for the documented team run', async () => {
    const events = await fixtureTimeline('provisional', T, 100);
    const items: readonly FeedItem[] = events.reduce(reduceFeed, initialFeedState()).items;
    const flat = items.map((i) => `${i.actorLabel}|${i.type === 'permission' ? `perm:${i.toolName}:${i.status}` : i.text}`);
    expect(flat[0]).toBe('JEBON|session started');
    expect(flat).toContain('architect|starting: Review the build plan');
    expect(flat.some((l) => l.startsWith('architect|done: '))).toBe(true);
    // Informational card (no runId): the later Stop closes it (A1.1), it is not left pending forever.
    expect(flat).toContain('JEBON|perm:Bash:expired');
    expect(flat.at(-1)).toBe('JEBON|session ended');
    expect(JSON.stringify(items)).not.toMatch(/tool_input|transcript_path|\/home\/user/);
  });
});

describe('BUG-14: delegations without subagent_type', () => {
  const GP: Actor = { kind: 'subagent', agentType: 'general-purpose', agentId: 'gp' };
  const agentTool = (useId: string, summary: string): ToolInfo => ({ name: 'Agent', useId, summary });

  it('the default subagent gets the untyped description; nothing stays pending', () => {
    const f = feed(
      ev('tool.start', { tool: agentTool('ag', 'Review the plan') }),
      ev('agent.start', { actor: GP }),
    );
    expect(texts(f).at(-1)).toBe('starting: Review the plan');
    expect(f.pendingDelegations).toEqual([]);
  });

  it('a typed delegation is preferred, and other types never take an untyped one', () => {
    const f = feed(
      ev('tool.start', { tool: agentTool('a1', 'Review the plan') }),
      ev('tool.start', { tool: agentTool('a2', 'general-purpose: Find files') }),
      ev('agent.start', { actor: GP }),
      ev('agent.start', { actor: CODER }),
    );
    expect(texts(f)).toEqual(['starting: Find files', 'starting']);
    expect(f.pendingDelegations).toEqual(['Review the plan']);
  });

  it("the Agent tool's end clears a delegation whose agent.start never came", () => {
    const f = feed(
      ev('tool.start', { tool: agentTool('a1', 'Explore: look around') }),
      ev('tool.end', { tool: agentTool('a1', 'Explore: look around') }),
    );
    expect(f.pendingDelegations).toEqual([]);
    expect(f.openToolIds).toEqual([]);
  });
});

describe('pending permission cards are pinned under the 500-item cap', () => {
  it('600 notifications after a pending actionable card do not evict it; resolved cards can go', () => {
    let f = reduceFeed(initialFeedState(), ev('permission.request', { runId: 'run_1', permission: { requestId: 'keep', toolName: 'Bash', summary: 'rm' } }));
    f = reduceFeed(f, ev('permission.request', { runId: 'run_1', permission: { requestId: 'done', toolName: 'Bash', summary: 'ls' } }));
    f = reduceFeed(f, ev('permission.resolved', { permission: { requestId: 'done', toolName: 'Bash', summary: 'ls', decision: 'deny' } }));
    for (let i = 0; i < 600; i++) f = reduceFeed(f, ev('notification', { text: `n${i}` }));
    expect(f.items.length).toBe(MAX_FEED_ITEMS);
    for (let i = 0; i < 10; i++) f = reduceFeed(f, ev('tool.start', { actor: CODER, tool: { name: 'Edit', useId: `g${i}`, summary: 's' } }));
    expect(f.items.length).toBeLessThanOrEqual(MAX_FEED_ITEMS); // tool lines fold into a group
    const perms = f.items.filter((i): i is FeedPermission => i.type === 'permission');
    expect(perms.map((p) => p.requestId)).toEqual(['keep']);
    expect(f.items[0]?.id).toBe('perm:keep');
    expect(f.items.at(-1)?.type).toBe('group');
    // Once decided, it ages out normally.
    f = reduceFeed(f, ev('permission.resolved', { permission: { requestId: 'keep', toolName: 'Bash', summary: 'rm', decision: 'allow' } }));
    for (let i = 0; i < 5; i++) f = reduceFeed(f, ev('notification', { text: `last${i}` }));
    expect(f.items.some((i) => i.type === 'permission')).toBe(false);
  });

  it('if everything is a pending informational card, the oldest still goes (hard bound)', () => {
    let f = initialFeedState();
    for (let i = 0; i < MAX_FEED_ITEMS + 3; i++) {
      f = reduceFeed(f, ev('permission.request', { permission: { requestId: `r${i}`, toolName: 'Bash', summary: 'x' } }));
    }
    expect(f.items.length).toBe(MAX_FEED_ITEMS);
    expect(f.items[0]?.id).toBe('perm:r3');
  });
});

describe('stripDonePrefix (UI-L8: "done: done.")', () => {
  const doneLine = (text: string) => texts(feed(ev('agent.stop', { actor: ARCH, emittedAt: T + ++n, text })))[0];

  it.each([
    ['done', 'done'],
    ['done.', 'done'],
    ['Done!', 'done'],
    ['done: tests pass', 'done: tests pass'],
    ['done. Node is v22', 'done: Node is v22'],
    ['DONE.  ', 'done'],
  ])('%j -> %j', (text, line) => {
    expect(doneLine(text)).toBe(line);
  });

  it('leaves other text alone, including words that merely start with "done"', () => {
    expect(doneLine('done with the build')).toBe('done: done with the build');
    expect(doneLine('Architect is done. Waiting')).toBe('done: Architect is done. Waiting');
    expect(doneLine('abandoned')).toBe('done: abandoned');
  });

  it('is unchanged for turn.stop and does not touch other kinds', () => {
    expect(texts(feed(ev('turn.stop', { actor: MAIN, emittedAt: T + ++n, text: 'done.' })))[0]).toBe('done');
    expect(texts(feed(ev('prompt.submit', { actor: MAIN, emittedAt: T + ++n, text: 'done. next' })))[0]).toBe('done. next');
  });
});
