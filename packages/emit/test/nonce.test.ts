// C-07b (plan A2.3, B-05): PermissionRequest and Notification ids carry a
// per-invocation nonce; every other kind keeps id = fingerprint(source, stdin).
import { describe, expect, it } from 'vitest';
import {
  EventIdSchema,
  OfficeEventSchema,
  bufferFlush,
  bufferPush,
  fingerprint,
  initialFeedState,
  initialReorderState,
  normalize,
  reduceFeed,
  type FeedPermission,
  type OfficeEvent,
} from '@agent-office/core';
import { emit, NONCE_HOOKS, type EmitDeps } from '../src/run.js';
import { LOCAL_HEADER_VALUE, dataDirWithToken, fixture } from './helpers.js';

const PERMISSION = fixture('pc2', '008-PermissionRequest-Bash-exec.json');
const NOTIFICATION = fixture('pc2', '009-Notification-exec.json');
const NOW = 1_700_000_000_000;

interface Rig {
  readonly deps: EmitDeps;
  readonly posted: string[];
  readonly env: Record<string, string>;
}

/** An emit rig with a fake fetch; `nonces` are handed out in order (and recorded as used). */
function rig(nonces: string[]): Rig & { used: () => number } {
  const home = dataDirWithToken();
  const posted: string[] = [];
  let used = 0;
  const deps: EmitDeps = {
    fetch: (_url, init) => {
      posted.push(typeof init?.body === 'string' ? init.body : '');
      return Promise.resolve(new Response(null, { status: 204 }));
    },
    now: () => NOW,
    readToken: () => LOCAL_HEADER_VALUE,
    nonce: () => {
      const n = nonces[Math.min(used, nonces.length - 1)] ?? 'x';
      used += 1;
      return n;
    },
  };
  return { deps, posted, env: { AGENT_OFFICE_HOME: home }, used: () => used };
}

const N1 = 'a'.repeat(32);
const N2 = 'b'.repeat(32);
const parsedAt = (r: Rig, i: number): OfficeEvent => JSON.parse(r.posted[i] ?? 'null') as OfficeEvent;

describe.each([
  ['PermissionRequest', PERMISSION],
  ['Notification', NOTIFICATION],
])('A2.3 AC1/AC2: two identical %s payloads', (_name, stdin) => {
  it('send two different, valid 64-hex ids', async () => {
    const r = rig([N1, N2]);
    expect(await emit(r.env, stdin, '/x/emit.mjs', r.deps)).toBe('sent');
    expect(await emit(r.env, stdin, '/x/emit.mjs', r.deps)).toBe('sent');
    const [a, b] = [parsedAt(r, 0), parsedAt(r, 1)];
    expect(a.id).not.toBe(b.id);
    for (const e of [a, b]) {
      expect(e.id).toMatch(/^[0-9a-f]{64}$/);
      expect(EventIdSchema.safeParse(e.id).success).toBe(true);
      expect(OfficeEventSchema.safeParse(e).success).toBe(true);
    }
  });

  it('AC4: a fixed nonce gives a reproducible id, and the nonce is not in the posted body', async () => {
    const one = rig([N1]);
    const two = rig([N1]);
    await emit(one.env, stdin, '/x/emit.mjs', one.deps);
    await emit(two.env, stdin, '/x/emit.mjs', two.deps);
    expect(parsedAt(one, 0).id).toBe(parsedAt(two, 0).id);
    expect(parsedAt(one, 0).id).toBe(await fingerprint('local', `${stdin}\n${N1}`));
    expect(one.posted[0]).not.toContain(N1);
  });
});

describe('A2.3 AC3: every other hook keeps id = fingerprint(source, stdin), whatever the nonce', () => {
  const others: [string, string][] = [
    ['PreToolUse', fixture('pc2', '005-PreToolUse-Bash-exec.json')],
    ['PostToolUse', fixture('pc2', '006-PostToolUse-Bash-exec.json')],
    ['PostToolUseFailure', fixture('pc2', '010-PostToolUseFailure-Bash-exec.json')],
    ['SessionStart', fixture('pc2', '001-SessionStart-exec.json')],
    ['UserPromptSubmit', fixture('pc2', '003-UserPromptSubmit-exec.json')],
    ['Stop', fixture('pc2', '011-Stop-exec.json')],
    ['SubagentStop', fixture('pc', '021-SubagentStop-architect-exec.json')],
    ['SessionEnd', fixture('pc2', '013-SessionEnd-exec.json')],
  ];
  it.each(others)('%s', async (_name, stdin) => {
    const r = rig([N1, N2]);
    await emit(r.env, stdin, '/x/emit.mjs', r.deps);
    await emit(r.env, stdin, '/x/emit.mjs', r.deps);
    const want = await fingerprint('local', stdin);
    expect(parsedAt(r, 0).id).toBe(want);
    expect(parsedAt(r, 1).id).toBe(want);
    expect(r.used()).toBe(0); // the nonce is not even requested
  });

  it('only PermissionRequest and Notification are in the nonce set', () => {
    expect([...NONCE_HOOKS].sort()).toEqual(['Notification', 'PermissionRequest']);
  });
});

describe('A2.3 AC5/AC6: cards and dedupe', () => {
  it('requestId === event.id; two identical asks give two distinct cards in reduceFeed', async () => {
    const r = rig([N1, N2]);
    await emit(r.env, PERMISSION, '/x/emit.mjs', r.deps);
    await emit(r.env, PERMISSION, '/x/emit.mjs', r.deps);
    const [a, b] = [parsedAt(r, 0), parsedAt(r, 1)];
    expect(a.kind).toBe('permission.request');
    expect(a.permission?.requestId).toBe(a.id);
    expect(b.permission?.requestId).toBe(b.id);
    const feed = [a, { ...b, emittedAt: a.emittedAt + 1 }].reduce(reduceFeed, initialFeedState());
    const cards = feed.items.filter((i): i is FeedPermission => i.type === 'permission');
    expect(cards).toHaveLength(2);
    expect(new Set(cards.map((c) => c.requestId)).size).toBe(2);
  });

  it('re-delivering the same event body (same id) is still deduped', async () => {
    const r = rig([N1]);
    await emit(r.env, PERMISSION, '/x/emit.mjs', r.deps);
    const e = parsedAt(r, 0);
    let st = bufferPush(initialReorderState(), e, NOW);
    st = bufferPush(st, JSON.parse(r.posted[0] ?? 'null') as OfficeEvent, NOW + 5);
    expect(bufferFlush(st).ready).toHaveLength(1);
  });

  it('normalize and fingerprint stay pure: same stdin and ctx give the same event, no nonce involved', async () => {
    const id = await fingerprint('local', PERMISSION);
    const payload = JSON.parse(PERMISSION) as Record<string, unknown>;
    const ctx = { id, emittedAt: 5, source: 'local' } as const;
    expect(normalize(payload, ctx)).toEqual(normalize(payload, ctx));
    expect(await fingerprint('local', PERMISSION)).toBe(id);
  });
});

describe('A2.3 AC7: bad input never throws', () => {
  it.each<[string, string, string]>([
    ['not JSON', 'not json {', 'malformed-input'],
    ['JSON but not an object', '"PermissionRequest"', 'malformed-input'],
    ['null', 'null', 'malformed-input'],
    ['missing hook_event_name', '{"session_id":"s1","cwd":"/a/b"}', 'ignored-event'],
    ['hook_event_name not a string', '{"hook_event_name":["PermissionRequest"],"session_id":"s1"}', 'ignored-event'],
    ['unknown hook name', '{"hook_event_name":"Nope","session_id":"s1"}', 'ignored-event'],
  ])('%s', async (_n, stdin, result) => {
    const r = rig([N1]);
    await expect(emit(r.env, stdin, '/x/emit.mjs', r.deps)).resolves.toBe(result);
    expect(r.posted).toHaveLength(0);
  });

  it('a throwing nonce source is a result value, not an exception', async () => {
    const r = rig([N1]);
    const deps: EmitDeps = {
      ...r.deps,
      nonce: () => {
        throw new Error('no entropy');
      },
    };
    await expect(emit(r.env, PERMISSION, '/x/emit.mjs', deps)).resolves.toBe('send-failed');
  });
});
