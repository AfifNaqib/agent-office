// Tests on OBSERVED fixtures (real Claude Code 2.1.306 on Windows, 2026-10-21):
// fixtures/hooks/{pc,pc2,pc-desktop}. They pin the S2 findings. The OBSERVED
// cloud set has its own tests in contract.test.ts (V1-S2c); docs-only event
// kinds are still covered by the PROVISIONAL set.
import { describe, expect, it } from 'vitest';
import { fingerprint } from '../src/fingerprint.js';
import { normalize } from '../src/normalize.js';
import { SYSTEM_PROMPT_MARKER, classifyPrompt, isSystemPrompt, type PromptKind } from '../src/prompt.js';
import { initialOfficeState, reduce, tick, type OfficeState } from '../src/reducers/avatar.js';
import { initialFeedState, reduceFeed, type FeedItem, type FeedState } from '../src/reducers/feed.js';
import { initialSessionsState, lobby, reduceSessions } from '../src/reducers/session.js';
import { summarizeTool } from '../src/redact.js';
import type { OfficeEvent } from '../src/schema.js';
import { HANDBACK_LABEL, HANDBACK_TOOL, toolDisplay } from '../src/toolActivity.js';
import { ev } from './helpers/events.js';
import { loadFixtures, observedTimeline, type FixtureSet } from './helpers/fixtures.js';

const T0 = 1_760_000_000_000;
const STEP = 100;
const OBSERVED_SETS = ['pc', 'pc2', 'pc-desktop'] as const;
const observed = loadFixtures().filter((f) => f.observed);

async function norm(payload: Record<string, unknown>): Promise<OfficeEvent | null> {
  const id = await fingerprint('local', JSON.stringify(payload));
  return normalize(payload, { id, emittedAt: T0, source: 'local' });
}

function fixture(set: FixtureSet, file: string): Record<string, unknown> {
  const f = observed.find((x) => x.set === set && x.file === file);
  if (!f) throw new Error(`missing fixture ${set}/${file}`);
  return f.payload;
}

describe('observed fixture inventory', () => {
  it('the three observed folders exist, are marked observed and are real captures', () => {
    for (const set of OBSERVED_SETS) {
      const files = observed.filter((f) => f.set === set);
      expect(files.length, set).toBeGreaterThan(5);
      expect(files.every((f) => !f.provisional), set).toBe(true);
    }
  });

  it('together they cover every FR-001 event except StopFailure (still provisional)', () => {
    const seen = new Set(observed.map((f) => String(f.payload.hook_event_name)));
    for (const hook of [
      'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
      'SubagentStart', 'SubagentStop', 'Stop', 'Notification', 'PermissionRequest',
    ]) {
      expect(seen, hook).toContain(hook);
    }
    expect(seen).not.toContain('StopFailure');
  });
});

describe('classifyPrompt (finding 1)', () => {
  it.each<[string, string | undefined, PromptKind]>([
    ['plain PO prompt', 'Use the architect subagent to read README.md', 'po'],
    ['empty', '', 'po'],
    ['undefined', undefined, 'po'],
    ['hand-back', '<agent-message from="a710a7da45c6a4ac1">\n[Subagent hand-back] ...', 'handback'],
    ['task notification', '<task-notification>\n<task-id>x</task-id>', 'task-notification'],
    ['side-session brief', 'Background (from the session that started this one):\nThe user asked...', 'side-session'],
    ['leading whitespace and BOM', '﻿ \n <agent-message from="x">', 'handback'],
    ['prefix must be at the start', 'please explain <agent-message to me', 'po'],
    ['different tag', '<agent-mess', 'po'],
    ['case matters', '<AGENT-MESSAGE from="x">', 'po'],
    ['Background without the exact phrase', 'Background (from my notes): hi', 'po'],
    // B-03: tags need a boundary; the side-session phrase is exact and at the very start.
    ['<agent-messages is not the tag', '<agent-messages from="x">', 'po'],
    ['<agent-message2', '<agent-message2', 'po'],
    ['<agent-message-x', '<agent-message-x>', 'po'],
    ['<task-notifications is not the tag', '<task-notifications>', 'po'],
    ['<task-notification:', '<task-notification:', 'po'],
    ['tag followed by >', '<agent-message>', 'handback'],
    ['tag followed by a space', '<task-notification id="1">', 'task-notification'],
    ['tag followed by a tab', '<agent-message\tfrom="x">', 'handback'],
    ['tag followed by a newline', '<task-notification\n', 'task-notification'],
    ['tag at the end of the text', '  <task-notification', 'task-notification'],
    ['side-session phrase with leading text', 'FYI Background (from the session that started this one): x', 'po'],
    ['side-session phrase after whitespace', '\nBackground (from the session that started this one): x', 'po'],
    ['side-session phrase is case sensitive', 'background (from the session that started this one)', 'po'],
    ['side-session phrase, near miss', 'Background (from the session that started this on)', 'po'],
  ])('%s', (_name, text, kind) => {
    expect(classifyPrompt(text)).toBe(kind);
    expect(isSystemPrompt(text)).toBe(kind !== 'po');
  });

  it('every marker classifies as its own kind (so reducers can read it back from event.text)', () => {
    for (const [kind, marker] of Object.entries(SYSTEM_PROMPT_MARKER)) expect(classifyPrompt(marker)).toBe(kind);
  });

  it('classifies every observed UserPromptSubmit and the normalized text agrees', async () => {
    const prompts = observed.filter((f) => f.payload.hook_event_name === 'UserPromptSubmit');
    expect(prompts.length).toBeGreaterThan(8);
    const kinds = new Set<PromptKind>();
    for (const f of prompts) {
      const kind = classifyPrompt(String(f.payload.prompt));
      kinds.add(kind);
      const e = await norm(f.payload);
      expect(e?.kind, f.file).toBe('prompt.submit');
      expect(classifyPrompt(e?.text), f.file).toBe(kind);
      if (kind !== 'po') expect(e?.text, f.file).toBe(SYSTEM_PROMPT_MARKER[kind]);
    }
    expect([...kinds].sort()).toEqual(['handback', 'po', 'side-session', 'task-notification']);
  });

  it('a system prompt never carries its body onto the wire', async () => {
    const body = 'SECRET-BODY report text password=hunter2';
    for (const prefix of ['<agent-message from="a1">\n', '<task-notification>\n', 'Background (from the session that started this one):\n']) {
      const e = await norm({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/x/repo', prompt: prefix + body });
      expect(JSON.stringify(e)).not.toContain('SECRET-BODY');
      expect(JSON.stringify(e)).not.toContain('hunter2');
      expect(isSystemPrompt(e?.text)).toBe(true);
    }
  });

  it('feed: a system prompt is never a "PO said" line; the PO prompt still is', () => {
    for (const text of Object.values(SYSTEM_PROMPT_MARKER)) {
      expect(reduceFeed(initialFeedState(), ev('prompt.submit', { text }))).toEqual(initialFeedState());
    }
    const s = reduceFeed(initialFeedState(), ev('prompt.submit', { text: 'fix the bug' }));
    expect(s.items).toMatchObject([{ kind: 'prompt', actorLabel: 'PO', text: 'fix the bug' }]);
  });

  it('avatar: a hand-back prompt means the lead is working again (a turn started)', () => {
    const s = reduce(initialOfficeState(), ev('prompt.submit', { text: SYSTEM_PROMPT_MARKER.handback }));
    expect(s.avatars.main?.activity).toBe('working');
  });
});

describe('SubagentHandback and ToolSearch (finding 3)', () => {
  // Secret-like text is built at runtime so the repo's secret scan stays clean.
  const report = `REPORT: all good. password=hunter2 ${['sk', 'ant', 'api03-abcdefghijklmnop'].join('-')} ${'x'.repeat(2000)}`;
  const handback = { hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/x/repo', agent_id: 'a1', agent_type: 'architect', tool_name: HANDBACK_TOOL, tool_use_id: 'toolu_1', tool_input: { message: report } };

  it('the report text never reaches the event, with a planted secret too', async () => {
    for (const hook of ['PreToolUse', 'PostToolUse']) {
      const e = await norm({ ...handback, hook_event_name: hook, tool_response: { success: true, message: report } });
      expect(e?.tool).toEqual({ name: HANDBACK_TOOL, useId: 'toolu_1', summary: '' });
      expect(JSON.stringify(e)).not.toMatch(/REPORT|hunter2|sk-ant|xxxx/);
    }
    expect(summarizeTool(HANDBACK_TOOL, { message: report })).toBe('');
  });

  it('renders as "reporting back" even if an emitter sent a summary', () => {
    expect(toolDisplay(HANDBACK_TOOL, 'the whole report')).toBe(HANDBACK_LABEL);
    const f = reduceFeed(initialFeedState(), ev('tool.start', { actor: { kind: 'subagent', agentType: 'architect', agentId: 'a1' }, tool: { name: HANDBACK_TOOL, useId: 't', summary: 'leaked report text' } }));
    expect(f.items).toMatchObject([{ type: 'line', kind: 'tool', text: 'reporting back', actorLabel: 'architect' }]);
    expect(JSON.stringify(f)).not.toContain('leaked');
    // an unmatched end (instant action) reads the same
    const g = reduceFeed(initialFeedState(), ev('tool.end', { tool: { name: HANDBACK_TOOL, useId: 'u', summary: 'leaked' } }));
    expect(g.items).toMatchObject([{ text: 'reporting back' }]);
  });

  it('observed ToolSearch gets its query as a short summary', async () => {
    const pre = await norm(fixture('pc', '006-PreToolUse-ToolSearch-exec.json'));
    const post = await norm(fixture('pc', '007-PostToolUse-ToolSearch-exec.json'));
    expect(pre).toMatchObject({ kind: 'tool.start', actor: { kind: 'main' }, tool: { name: 'ToolSearch', summary: 'select:WebFetch' } });
    expect(post).toMatchObject({ kind: 'tool.end', tool: { name: 'ToolSearch', summary: 'select:WebFetch', durationMs: 2 } });
  });

  it('ToolSearch summary is capped at 40 and scrubbed', () => {
    expect(summarizeTool('ToolSearch', { query: 'q'.repeat(100) }).length).toBe(40);
    expect(summarizeTool('ToolSearch', { query: 'token=abc12345' })).not.toContain('abc12345');
    expect(summarizeTool('ToolSearch', { query: 5 })).toBe('');
  });

  it('observed hand-backs normalize to the architect and tester (no text)', async () => {
    const a = await norm(fixture('pc', '019-PreToolUse-SubagentHandback-architect-exec.json'));
    const t = await norm(fixture('pc', '028-PreToolUse-SubagentHandback-tester-exec.json'));
    expect(a).toMatchObject({ kind: 'tool.start', actor: { kind: 'subagent', agentType: 'architect' }, tool: { name: HANDBACK_TOOL, summary: '' } });
    expect(t).toMatchObject({ kind: 'tool.start', actor: { kind: 'subagent', agentType: 'tester' } });
    expect(a?.text).toBeUndefined();
  });
});

describe('empty-type SubagentStop (finding 5)', () => {
  it('is ignored in every observed session (one internal helper per session)', async () => {
    const stops = observed.filter((f) => f.payload.hook_event_name === 'SubagentStop' && f.payload.agent_type === '');
    expect(stops.map((f) => `${f.set}/${f.file}`)).toEqual([
      'cloud/034-SubagentStop-exec.json',
      'pc/026-SubagentStop-exec.json',
      'pc/034-SubagentStop-exec.json',
      'pc2/012-SubagentStop-exec.json',
      'pc-desktop/025-SubagentStop-exec.json',
    ]);
    for (const f of stops) expect(await norm(f.payload), `${f.set}/${f.file}`).toBeNull();
  });

  it('typed SubagentStops are kept', async () => {
    expect(await norm(fixture('pc', '021-SubagentStop-architect-exec.json'))).toMatchObject({ kind: 'agent.stop', actor: { agentType: 'architect' } });
    expect(await norm(fixture('pc', '030-SubagentStop-tester-exec.json'))).toMatchObject({ kind: 'agent.stop', actor: { agentType: 'tester' } });
  });
});

describe('permission shapes (finding 6)', () => {
  it('PermissionRequest: no tool_use_id and no agent in the payload -> a main-actor request', async () => {
    for (const [set, file] of [['pc2', '008-PermissionRequest-Bash-exec.json'], ['pc-desktop', '016-PermissionRequest-Bash-exec.json']] as const) {
      const p = fixture(set, file);
      expect(p).not.toHaveProperty('tool_use_id');
      expect(p).not.toHaveProperty('agent_id');
      expect(p).toHaveProperty('permission_suggestions');
      const e = await norm(p);
      expect(e).toMatchObject({ kind: 'permission.request', actor: { kind: 'main' }, permission: { toolName: 'Bash', summary: 'node -e' } });
      expect(e?.permission?.requestId).toBe(e?.id);
      expect(e?.tool).toBeUndefined();
      expect(JSON.stringify(e)).not.toMatch(/permission_suggestions|addRules|process\.exit/);
    }
  });

  it('Notification: the message only, no tool info', async () => {
    for (const [set, file] of [['pc2', '009-Notification-exec.json'], ['pc-desktop', '020-Notification-exec.json']] as const) {
      const e = await norm(fixture(set, file));
      expect(e).toMatchObject({ kind: 'notification', text: 'Claude needs your permission' });
      expect(e?.tool).toBeUndefined();
      expect(e?.permission).toBeUndefined();
    }
  });

  it('PostToolUseFailure: "Exit code 3", tool id and duration; no is_interrupt or error body on the wire', async () => {
    const e = await norm(fixture('pc2', '010-PostToolUseFailure-Bash-exec.json'));
    expect(e).toMatchObject({
      kind: 'tool.fail',
      text: 'Exit code 3',
      tool: { name: 'Bash', summary: 'node -e', durationMs: 342 },
    });
    expect(e?.tool?.useId).toMatch(/^toolu_/);
    expect(JSON.stringify(e)).not.toContain('is_interrupt');
  });

  it('feed: a Notification is a text line and never creates a card', async () => {
    const n = await norm(fixture('pc2', '009-Notification-exec.json'));
    if (!n) throw new Error('notification expected');
    const f = reduceFeed(initialFeedState(), n);
    expect(f.items).toMatchObject([{ type: 'line', kind: 'notification', text: 'Claude needs your permission' }]);
    expect(f.items.some((i) => i.type === 'permission')).toBe(false);
  });

  it('feed + avatar: a failed Bash is an error line "Exit code 3" and a 2 s error', async () => {
    const start = await norm(fixture('pc2', '007-PreToolUse-Bash-exec.json'));
    const fail = await norm(fixture('pc2', '010-PostToolUseFailure-Bash-exec.json'));
    if (!start || !fail) throw new Error('fixtures expected');
    const f = [start, fail].reduce(reduceFeed, initialFeedState());
    expect(f.items.map((i) => (i.type === 'line' ? `${i.kind}: ${i.text}` : i.type))).toEqual([
      'tool: Bash node -e',
      'error: Bash node -e failed (Exit code 3)',
    ]);
    expect(f.openToolIds).toEqual([]);
    const o = [start, fail].reduce(reduce, initialOfficeState());
    expect(o.avatars.main).toMatchObject({ activity: 'error', openTools: [] });
    expect(tick(o, fail.emittedAt + 2_000).avatars.main?.activity).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// Replays
// ---------------------------------------------------------------------------

interface Replay {
  readonly office: OfficeState;
  readonly feed: FeedState;
}

function replay(events: readonly OfficeEvent[], until?: (e: OfficeEvent) => boolean): Replay {
  let office = initialOfficeState();
  let feed = initialFeedState();
  for (const e of events) {
    office = reduce(office, e);
    feed = reduceFeed(feed, e);
    if (until?.(e)) break;
  }
  return { office, feed };
}

const act = (r: Replay, key: string): string | undefined => r.office.avatars[key]?.activity;
const lines = (items: readonly FeedItem[]): string[] =>
  items.map((i) => (i.type === 'permission' ? `perm ${i.status}: ${i.toolName} ${i.summary}` : i.type === 'line' ? `${i.actorLabel} ${i.kind}: ${i.text}` : `group ${i.text}`));

describe('replay: observed CLI session (architect + tester, auto mode)', () => {
  it('desks work and finish on their own agent.stop; Stop does not idle the team', async () => {
    const events = await observedTimeline('pc', T0, STEP);
    expect(new Set(events.map((e) => e.sessionId)).size).toBe(1);

    // After the first Stop the main turn is "done" but the tester is still running Bash.
    const afterStop = replay(events, (e) => e.kind === 'turn.stop');
    expect(act(afterStop, 'main')).toBe('done');
    expect(act(afterStop, 'architect')).toBe('done');
    expect(afterStop.office.avatars.tester).toMatchObject({ activity: 'running', tool: { name: 'Bash' } });

    // Their own stops finish them; the last Stop ends the turn.
    const beforeEnd = replay(events, (e) => e.kind === 'turn.stop' && e.text === 'done');
    expect(['main', 'architect', 'tester'].map((k) => act(beforeEnd, k))).toEqual(['done', 'done', 'done']);
    expect(act(beforeEnd, 'coder')).toBe('idle');

    // The session ends: everyone idle, no visitors (the empty-type helper never appeared).
    const end = replay(events);
    expect(Object.values(end.office.avatars).every((a) => a.activity === 'idle')).toBe(true);
    expect(Object.keys(end.office.avatars).sort()).toEqual(['architect', 'coder', 'main', 'manager', 'tester']);
  });

  it('subagents stay working even if the main Stop arrives long before them (no timer needed)', async () => {
    const events = await observedTimeline('pc', T0, STEP);
    const stopAt = events.findIndex((e) => e.kind === 'turn.stop');
    const r = replay(events.slice(0, stopAt + 1));
    expect(tick(r.office, events[stopAt]?.emittedAt ?? 0).avatars.tester?.activity).toBe('running');
  });

  it('feed: one PO prompt, two hand-backs shown as "reporting back", no system prompt, no report text', async () => {
    const events = await observedTimeline('pc', T0, STEP);
    const out = lines(replay(events).feed.items);
    expect(out.filter((l) => l.startsWith('PO prompt:'))).toHaveLength(1);
    expect(out.filter((l) => l.endsWith('reporting back'))).toEqual(['architect tool: reporting back', 'tester tool: reporting back']);
    expect(out).toContain('JEBON tool: ToolSearch select:WebFetch');
    expect(out).toContain('architect starting: starting: Read README, grep decisions');
    expect(out).toContain('tester starting: starting: Run two node commands');
    expect(out).toContain("JEBON done: done: Architect's done. Waiting on the tester.");
    expect(out.at(-1)).toBe('JEBON session: session ended');
    const joined = JSON.stringify(out);
    expect(joined).not.toMatch(/agent-message|hand-back|task-notification|README summary/i);
  });

  it('lobby: one live session, not a side session; ended after SessionEnd', async () => {
    const events = await observedTimeline('pc', T0, STEP);
    let s = initialSessionsState();
    for (const e of events.slice(0, -1)) s = reduceSessions(s, e);
    const last = events.at(-1);
    if (!last) throw new Error('events expected');
    const live = lobby(s, last.emittedAt);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ status: 'live', side: false, repo: 'agent-office' });
    expect(lobby(reduceSessions(s, last), last.emittedAt)[0]?.status).toBe('ended');
  });
});

describe('replay: observed CLI session in default mode (permission, failing Bash)', () => {
  it('main waits, then errors for 2 s, then the turn is done', async () => {
    const events = await observedTimeline('pc2', T0, STEP);
    const waiting = replay(events, (e) => e.kind === 'permission.request');
    expect(waiting.office.avatars.main).toMatchObject({ activity: 'waiting', tool: { name: 'Bash', summary: 'node -e' } });
    const failed = replay(events, (e) => e.kind === 'tool.fail');
    expect(act(failed, 'main')).toBe('error');
    expect(act(replay(events, (e) => e.kind === 'turn.stop'), 'main')).toBe('done');
  });

  it('the observed PermissionRequest is an informational card: pending through the Notification, closed by the failing Bash', async () => {
    const events = await observedTimeline('pc2', T0, STEP);
    const afterNotice = replay(events, (e) => e.kind === 'notification').feed.items;
    expect(afterNotice.filter((i) => i.type === 'permission')).toMatchObject([
      { toolName: 'Bash', summary: 'node -e', status: 'pending', actionable: false, runId: null, actorKey: 'main' },
    ]);
    const end = replay(events).feed.items.filter((i) => i.type === 'permission');
    expect(end).toMatchObject([{ status: 'expired', settledBy: 'activity', actionable: false }]);
  });

  it('the empty-type SubagentStop adds nothing (no visitor)', async () => {
    const events = await observedTimeline('pc2', T0, STEP);
    expect(events.some((e) => e.kind === 'agent.stop')).toBe(false);
    expect(Object.keys(replay(events).office.avatars)).not.toContainEqual(expect.stringContaining('visitor'));
  });
});

describe('replay: observed Desktop app (two sessions in one folder)', () => {
  async function sessions() {
    const events = await observedTimeline('pc-desktop', T0, STEP);
    const ids = [...new Set(events.map((e) => e.sessionId))];
    const side = ids.find((id) => events.find((e) => e.sessionId === id && e.kind === 'prompt.submit')?.text === SYSTEM_PROMPT_MARKER['side-session']);
    const main = ids.find((id) => id !== side);
    if (!side || !main) throw new Error('two sessions expected');
    return { events, side, main };
  }

  it('lobby hides the side session by default and labels it when asked', async () => {
    const { events, side, main } = await sessions();
    const s = events.reduce(reduceSessions, initialSessionsState());
    const now = (events.at(-1)?.emittedAt ?? 0) + 1;
    expect(lobby(s, now).map((x) => x.sessionId)).toEqual([main]);
    const all = lobby(s, now, { includeSide: true });
    expect(all.map((x) => [x.sessionId, x.side]).sort()).toEqual([[main, false], [side, true]].sort());
    // the hidden session keeps its events
    expect(s.sessions[`local:${side}`]?.eventCount).toBeGreaterThan(3);
  });

  it('the side session never ends by itself; the 120 s quiet rule idles it', async () => {
    const { events, side } = await sessions();
    const sideEvents = events.filter((e) => e.sessionId === side);
    expect(sideEvents.some((e) => e.kind === 'session.end')).toBe(false);
    const s = sideEvents.reduce(reduceSessions, initialSessionsState());
    const lastAt = sideEvents.at(-1)?.emittedAt ?? 0;
    expect(lobby(s, lastAt + 1_000, { includeSide: true })[0]?.status).toBe('live');
    expect(lobby(s, lastAt + 120_000, { includeSide: true })[0]?.status).toBe('idle');
  });

  it('side-session flag follows the FIRST prompt only', () => {
    const sideBrief = SYSTEM_PROMPT_MARKER['side-session'];
    const a = [ev('prompt.submit', { sessionId: 'x', emittedAt: 1, text: 'hello' }), ev('prompt.submit', { sessionId: 'x', emittedAt: 2, text: sideBrief })];
    const b = [ev('prompt.submit', { sessionId: 'y', emittedAt: 1, text: sideBrief }), ev('prompt.submit', { sessionId: 'y', emittedAt: 2, text: 'hello' })];
    expect(a.reduce(reduceSessions, initialSessionsState()).sessions['local:x']?.side).toBe(false);
    expect(b.reduce(reduceSessions, initialSessionsState()).sessions['local:y']?.side).toBe(true);
    // a session with no prompt yet is a normal session
    expect(reduceSessions(initialSessionsState(), ev('session.start', { sessionId: 'z' })).sessions['local:z']?.side).toBe(false);
  });

  it('the PO session: architect works then finishes, main idles at the end, no system prompt in the feed', async () => {
    const { events, main } = await sessions();
    const mine = events.filter((e) => e.sessionId === main);

    const working = replay(mine, (e) => e.kind === 'agent.start');
    expect(act(working, 'architect')).toBe('working');
    const reading = replay(mine, (e) => e.kind === 'tool.start' && e.actor.agentType === 'architect');
    expect(reading.office.avatars.architect).toMatchObject({ activity: 'reading', tool: { name: 'Read' } });
    const done = replay(mine, (e) => e.kind === 'agent.stop');
    expect(act(done, 'architect')).toBe('done');
    expect(act(done, 'main')).toBe('waiting'); // the Bash permission is still open

    const end = replay(mine);
    expect(Object.values(end.office.avatars).every((a) => a.activity === 'idle')).toBe(true);
    // The permission card stayed pending while the architect worked and was closed by the failing Bash.
    expect(replay(mine, (e) => e.kind === 'agent.stop').feed.items.filter((i) => i.type === 'permission')).toMatchObject([{ status: 'pending' }]);
    expect(end.feed.items.filter((i) => i.type === 'permission')).toMatchObject([{ status: 'expired', settledBy: 'activity', actionable: false }]);

    const out = lines(end.feed.items);
    expect(out.filter((l) => l.startsWith('PO prompt:'))).toHaveLength(1);
    expect(out).toContain('architect starting: starting: Read README.md');
    expect(out).toContain('JEBON error: Bash node -e failed (Exit code 3)');
    expect(out).toContain('JEBON notification: Claude needs your permission');
    expect(JSON.stringify(out)).not.toMatch(/task-notification|Background \(from/);
  });

  it('the side session feed never shows its brief as something the PO said', async () => {
    const { events, side } = await sessions();
    const out = lines(replay(events.filter((e) => e.sessionId === side)).feed.items);
    expect(out.some((l) => l.startsWith('PO '))).toBe(false);
    expect(JSON.stringify(out)).not.toContain('Background (from');
  });
});
