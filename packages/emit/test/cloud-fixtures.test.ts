// V1-S2c (plan A3.2): emit() in-process on every OBSERVED cloud fixture with a
// cloud-like env. The S2 capture recorded env var PRESENCE only, so the remote
// id here is a fake of the real shape (cse_ + 24 base62). A fake fetch records
// the posts; nothing leaves the process.
import { describe, expect, it } from 'vitest';
import { OfficeEventSchema, type OfficeEvent } from '@agent-office/core';
import { emit, type EmitDeps } from '../src/run.js';
import { loadFixtureSet } from './helpers.js';

const REMOTE_ID = 'cse_01AbCdEfGhIjKlMnOpQrStUv';
const CLOUD = { CLAUDE_CODE_REMOTE_SESSION_ID: REMOTE_ID, CLAUDE_CODE_REMOTE: 'true', AGENT_OFFICE_RELAY_URL: 'https://relay.test' };
const cloud = loadFixtureSet('cloud');

interface Post {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

async function send(env: Record<string, string>, stdin: string): Promise<{ result: string; posts: Post[] }> {
  const posts: Post[] = [];
  const deps: EmitDeps = {
    fetch: (url, init) => {
      const body = init?.body;
      posts.push({
        url: url instanceof Request ? url.url : url instanceof URL ? url.href : url,
        headers: init?.headers as Record<string, string>,
        body: typeof body === 'string' ? body : '',
      });
      return Promise.resolve(new Response(null, { status: 204 }));
    },
    now: () => 1_760_000_000_000,
    readToken: () => undefined,
    nonce: () => '0'.repeat(32),
  };
  const result = await emit(env, stdin, '/x/agent-office-emit.mjs', deps);
  return { result, posts };
}

describe('emit on the cloud fixtures (V1-S2c)', () => {
  it('there are 46 of them', () => {
    expect(cloud).toHaveLength(46);
  });

  it.each(cloud.map((f) => [f.file, f] as const))('%s: one POST to the relay /ingest (or ignored), no credential, source cloud + cse_ id', async (_n, f) => {
    const { result, posts } = await send(CLOUD, JSON.stringify(f.payload));
    if (f.payload.hook_event_name === 'SubagentStop' && f.payload.agent_type === '') {
      expect(result).toBe('ignored-event');
      expect(posts).toHaveLength(0);
      return;
    }
    expect(result).toBe('sent');
    expect(posts).toHaveLength(1);
    const post = posts[0];
    if (!post) return;
    expect(post.url).toBe('https://relay.test/ingest');
    expect(Object.keys(post.headers).map((k) => k.toLowerCase())).toEqual(['content-type']);
    const ev = JSON.parse(post.body) as OfficeEvent;
    expect(OfficeEventSchema.safeParse(ev).success).toBe(true);
    expect(ev).toMatchObject({ source: 'cloud', sessionId: f.payload.session_id, remoteSessionId: REMOTE_ID });
  });

  it('CLAUDE_EFFORT set or missing gives the same body for every fixture', async () => {
    for (const f of cloud) {
      const stdin = JSON.stringify(f.payload);
      const without = await send(CLOUD, stdin);
      const withEffort = await send({ ...CLOUD, CLAUDE_EFFORT: 'medium' }, stdin);
      expect(withEffort.result, f.file).toBe(without.result);
      expect(withEffort.posts.map((p) => p.body), f.file).toEqual(without.posts.map((p) => p.body));
    }
  });
});
