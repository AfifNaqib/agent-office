// V0-05/V0-06: events -> one office + its feed. Events go through the core reorder
// buffer (FR-010, receiver clock); the office and feed show ONE session (A1.3: no
// merged view). By default that is the most recently active non-side session in
// the lobby, switching only after the shown one has been quiet for
// FOLLOW_QUIET_MS, so two busy sessions don't flip the room back and forth. The
// PO can pin a session from the lobby instead.
import {
  bufferDrain,
  bufferPush,
  initialFeedState,
  initialOfficeState,
  initialReorderState,
  initialSessionsState,
  lobby,
  reduce,
  reduceFeed,
  reduceSessions,
  sessionKey,
  tick,
  tickFeed,
  type FeedState,
  type LobbyEntry,
  type OfficeEvent,
  type OfficeState,
} from '@agent-office/core';

export const FOLLOW_QUIET_MS = 10_000;
/** Per-session history kept for rebuilding the office on a switch. */
export const MAX_SESSION_EVENTS = 5_000;

export class Follower {
  private rs = initialReorderState();
  private sessions = initialSessionsState();
  private readonly history = new Map<string, OfficeEvent[]>();
  private selected: string | null = null;
  private pinned: string | null = null;
  private office: OfficeState = initialOfficeState();
  private feedState: FeedState = initialFeedState();

  /** Key of the session on screen; changes when the office switches session. */
  get shownKey(): string | null {
    return this.selected;
  }

  /** Pinned session key, or null when following the newest. */
  get pinnedKey(): string | null {
    return this.pinned;
  }

  /** Feed of the shown session (same object until something changes). */
  get feed(): FeedState {
    return this.feedState;
  }

  push(e: OfficeEvent, now: number): void {
    // shortcut: bufferPush copies its 4096-id seen list per event (BUG-13), ~2 s for 20k history events; batch history if that hurts.
    this.rs = bufferPush(this.rs, e, now);
  }

  /** Show `key` until unpinned; null = follow the newest session again. */
  pin(key: string | null): void {
    this.pinned = key;
    if (key !== null && this.sessions.sessions[key]) this.show(key);
  }

  reset(): void {
    this.rs = initialReorderState();
    this.sessions = initialSessionsState();
    this.history.clear();
    this.selected = null;
    this.pinned = null;
    this.office = initialOfficeState();
    this.feedState = initialFeedState();
  }

  lobby(now: number): LobbyEntry[] {
    return lobby(this.sessions, now);
  }

  /** The session on screen, with its lobby status. */
  current(now: number): LobbyEntry | undefined {
    return this.lobby(now).find((s) => s.key === this.selected);
  }

  private show(key: string): void {
    this.selected = key;
    const events = this.history.get(key) ?? [];
    this.office = events.reduce(reduce, initialOfficeState());
    this.feedState = events.reduce(reduceFeed, initialFeedState());
  }

  advance(now: number): OfficeState {
    const { state, ready } = bufferDrain(this.rs, now);
    this.rs = state;
    for (const e of ready) {
      const key = sessionKey(e);
      this.sessions = reduceSessions(this.sessions, e);
      const list = this.history.get(key) ?? [];
      list.push(e);
      if (list.length > MAX_SESSION_EVENTS) list.shift();
      this.history.set(key, list);
      if (key === this.selected) {
        this.office = reduce(this.office, e);
        this.feedState = reduceFeed(this.feedState, e);
      }
    }
    if (this.pinned !== null && this.pinned !== this.selected && this.sessions.sessions[this.pinned]) {
      this.show(this.pinned);
    } else if (this.pinned === null) {
      const newest = lobby(this.sessions, now)[0];
      const shown = this.selected === null ? undefined : this.sessions.sessions[this.selected];
      if (newest && newest.key !== this.selected && (!shown || newest.lastEventAt - shown.lastEventAt >= FOLLOW_QUIET_MS)) {
        this.show(newest.key);
      }
    }
    this.office = tick(this.office, now);
    this.feedState = tickFeed(this.feedState, now);
    return this.office;
  }
}
