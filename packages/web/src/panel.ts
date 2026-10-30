// Side panel (V0-06, FR-011 to FR-016): lobby, feed, permission cards. Plain DOM:
// every string goes in through textContent (never innerHTML), as the feed
// reducer expects (§11 XSS). Only re-rendered when its input object changes.
import type { FeedItem, FeedPermission, FeedState, LobbyEntry } from '@agent-office/core';

/** Name-tag colours, same as the office (art direction: agent colour on tags only). */
export const TAG_CSS: Readonly<Record<string, string>> = {
  main: '#ffffff',
  po: '#ff2d2d',
  architect: '#7fb2ff',
  coder: '#7dff9a',
  tester: '#ffd166',
  manager: '#c792ea',
};
const VISITOR_CSS = '#9e9e9e';

/** A1.1 label table. Status is always shown as text, never by colour alone (V0-06 AC). */
export function permissionLabel(c: Pick<FeedPermission, 'status' | 'settledBy' | 'actionable'>): string {
  switch (c.status) {
    case 'pending':
      return c.actionable ? 'Waiting for you' : 'Waiting in Claude';
    case 'allow':
      return 'Allowed';
    case 'deny':
      return 'Denied';
    case 'expired':
      if (c.settledBy === 'timeout') return 'No longer tracked. Check Claude';
      if (c.actionable) return c.settledBy === 'decision' ? 'Auto-denied: no decision in 4 min' : 'Run ended';
      return 'Handled in Claude';
  }
}

/** FR-016 hint for an informational card: where to answer it. */
export function answerHint(s: Pick<LobbyEntry, 'source' | 'openUrl' | 'controllable'> | undefined): { text: string; url?: string } {
  if (s?.openUrl) return { text: 'Open in Claude', url: s.openUrl };
  if (s?.source === 'local' && !s.controllable) return { text: 'Answer in Claude. Use Remote Control (/rc) in that session' };
  return { text: 'Answer in Claude' };
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const hhmm = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const tagColor = (key: string): string => TAG_CSS[key] ?? VISITOR_CSS;

function itemNode(it: FeedItem, session: LobbyEntry | undefined): HTMLLIElement {
  const li = el('li', `item ${it.type === 'line' ? it.kind : it.type}`);
  li.append(el('time', 'at', hhmm(it.at)));
  const who = el('span', 'who', it.actorLabel);
  who.style.color = tagColor(it.actorKey);
  li.append(who);
  if (it.type !== 'permission') {
    li.append(el('span', 'text', it.text));
    return li;
  }
  const card = el('div', `card ${it.status}`);
  card.append(el('div', 'card-tool', `${it.toolName} ${it.summary}`.trim()));
  card.append(el('div', 'card-status', permissionLabel(it)));
  if (it.status === 'pending' && !it.actionable) {
    const hint = answerHint(session);
    if (hint.url) {
      const a = el('a', 'card-hint', hint.text);
      a.href = hint.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      card.append(a);
    } else {
      card.append(el('div', 'card-hint', hint.text));
    }
  }
  li.append(card);
  return li;
}

/** What one lobby row shows. Pure, so it can be tested without a DOM. */
export interface LobbyRow {
  readonly key: string;
  readonly badge: string;
  readonly repo: string;
  readonly meta: string;
  readonly status: string;
  readonly pressed: boolean;
}

export function lobbyRows(entries: readonly LobbyEntry[], shown: string | null, now: number): LobbyRow[] {
  return entries.map((s) => ({
    key: s.key,
    badge: s.source === 'local' ? 'PC' : 'Cloud',
    repo: s.repo ?? s.sessionId,
    meta: `${s.status} · ${ago(now - s.lastEventAt)}`,
    status: s.status,
    pressed: s.key === shown,
  }));
}

/** One lobby button. Created once per session key and then updated in place (W-01: keyboard focus survives). */
class LobbyButton {
  readonly root = el('button', 'session');
  private readonly badge = el('span', 'badge');
  private readonly repo = el('span', 'repo');
  private readonly meta = el('span', 'meta');

  constructor(key: string, onPick: (key: string) => void) {
    this.root.type = 'button';
    this.root.append(this.badge, this.repo, this.meta);
    this.root.onclick = () => {
      onPick(key);
    };
  }

  update(r: LobbyRow): void {
    setText(this.badge, r.badge);
    setText(this.repo, r.repo);
    setText(this.meta, r.meta);
    const cls = `session ${r.status}`;
    if (this.root.className !== cls) this.root.className = cls;
    this.root.setAttribute('aria-pressed', String(r.pressed));
  }
}

/** Write only when the text changed, so a 1 s tick does not touch unchanged nodes. */
function setText(e: HTMLElement, text: string): void {
  if (e.textContent !== text) e.textContent = text;
}

/**
 * B3: where focus goes when the focused session button is removed. `order` is the lobby
 * order before the removal, `keep` the keys that stay. The next kept session, else the
 * previous kept one, else null (= the "Follow newest" button). Never nothing.
 */
export function focusHeir(order: readonly string[], removed: string, keep: ReadonlySet<string>): string | null {
  const at = order.indexOf(removed);
  const after = order.slice(at + 1).find((k) => keep.has(k));
  if (after !== undefined) return after;
  const before = order.slice(0, Math.max(0, at)).reverse().find((k) => keep.has(k));
  return before ?? null;
}

export class Panel {
  private lastFeed: FeedState | null = null;
  private lastAnnounced = '';
  private announceAt = 0;
  private readonly buttons = new Map<string, LobbyButton>();
  private readonly follow: HTMLButtonElement;
  private readonly empty = el('p', 'empty', 'No sessions yet. Start Claude on this PC.');

  constructor(
    private readonly lobbyEl: HTMLElement,
    private readonly feedEl: HTMLElement,
    private readonly liveEl: HTMLElement,
    private readonly onPick: (key: string | null) => void,
  ) {
    this.follow = el('button', 'session follow');
    this.follow.type = 'button';
    this.follow.onclick = () => {
      this.onPick(null);
    };
    this.lobbyEl.replaceChildren(this.follow);
  }

  /**
   * Updates the lobby in place: one persistent button per session key, text and
   * aria-pressed changed on the existing nodes, nodes added or removed only when
   * the session list changes, and moved only when the order changes. Focus is
   * put back if a move or removal took it away.
   */
  renderLobby(entries: readonly LobbyEntry[], shown: string | null, pinned: string | null, now: number): void {
    setText(this.follow, pinned === null ? '● Following newest' : '○ Follow newest');
    this.follow.setAttribute('aria-pressed', String(pinned === null));
    const rows = lobbyRows(entries, shown, now);
    const wanted = new Set(rows.map((r) => r.key));
    const active = document.activeElement;
    let heir: HTMLElement | null = null;
    for (const [key, b] of this.buttons) {
      if (wanted.has(key)) continue;
      if (b.root === active) heir = this.heirOf(key, wanted);
      b.root.remove();
      this.buttons.delete(key);
    }
    // Order: follow button, then rows in `rows` order, or the empty note.
    let anchor: Element = this.follow;
    for (const r of rows) {
      let b = this.buttons.get(r.key);
      if (!b) {
        b = new LobbyButton(r.key, this.onPick);
        this.buttons.set(r.key, b);
      }
      b.update(r);
      if (anchor.nextElementSibling !== b.root) anchor.after(b.root);
      anchor = b.root;
    }
    if (rows.length === 0) {
      if (!this.empty.isConnected) this.lobbyEl.append(this.empty);
    } else if (this.empty.isConnected) {
      this.empty.remove();
    }
    if (heir) heir.focus();
    else if (active instanceof HTMLElement && active !== document.activeElement && active.isConnected) active.focus();
  }

  private heirOf(removed: string, keep: ReadonlySet<string>): HTMLElement {
    const key = focusHeir([...this.buttons.keys()].sort((a, b) => this.position(a) - this.position(b)), removed, keep);
    return (key === null ? undefined : this.buttons.get(key)?.root) ?? this.follow;
  }

  /** Document position of a session button inside the lobby (DOM order is the lobby order). */
  private position(key: string): number {
    const root = this.buttons.get(key)?.root;
    return root ? [...this.lobbyEl.children].indexOf(root) : -1;
  }

  renderFeed(feed: FeedState, session: LobbyEntry | undefined, now: number): void {
    if (feed === this.lastFeed) return;
    this.lastFeed = feed;
    const nearBottom = this.feedEl.scrollHeight - this.feedEl.scrollTop - this.feedEl.clientHeight < 40;
    this.feedEl.replaceChildren(...feed.items.map((it) => itemNode(it, session)));
    if (nearBottom) this.feedEl.scrollTop = this.feedEl.scrollHeight;
    this.announce(feed.items.at(-1), now);
  }

  /** FR-013: polite live region, at most one announcement per 2 s. */
  private announce(it: FeedItem | undefined, now: number): void {
    if (!it || it.id === this.lastAnnounced || now - this.announceAt < 2_000) return;
    this.lastAnnounced = it.id;
    this.announceAt = now;
    this.liveEl.textContent = `${it.actorLabel}: ${it.type === 'permission' ? `${it.toolName}, ${permissionLabel(it)}` : it.text}`;
  }
}
