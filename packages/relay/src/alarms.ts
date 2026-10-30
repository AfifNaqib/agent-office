// A Durable Object has ONE alarm. Since V1-04 it serves two jobs:
// - the daily retention pass (FR-018, hubCore runRetentionAlarm), whose due time is
//   kept in DO storage under RETENTION_AT_KEY instead of being the alarm itself;
// - while the bridge is connected, a check every BRIDGE_CHECK_MS that closes a bridge
//   socket that stopped answering pings, so the UI learns "PC offline".
// The alarm is always set to the earlier of the two. Free of Workers globals (fake storage in tests).
import { BRIDGE_CHECK_MS } from './bridgeSockets.js';
import { ensureRetentionAlarm, runRetentionAlarm, type AlarmApi, type HubCore } from './hubCore.js';
import type { Logger } from './log.js';

export const RETENTION_AT_KEY = 'retentionAt';

/** The parts of DurableObjectStorage used here. */
export interface AlarmStorage extends AlarmApi {
  get(key: string): Promise<unknown>;
  put(key: string, value: number): Promise<void>;
}

/** The retention due time as an AlarmApi, so the hubCore retention helpers work unchanged. */
export function retentionClock(storage: AlarmStorage): AlarmApi {
  return {
    getAlarm: async () => {
      const v = await storage.get(RETENTION_AT_KEY);
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    },
    setAlarm: (t) => storage.put(RETENTION_AT_KEY, t),
  };
}

/**
 * L-1 migration from a pre-V1-04 deploy: there the DO alarm WAS the retention due time
 * (daily, or the 60 s "more" alarm). With no retentionAt key yet and an alarm set, that
 * alarm time becomes retentionAt, so the switch neither delays retention ~24 h once nor
 * breaks a "more" run. Runs before anything else reads retentionAt; a no-op afterwards.
 */
export async function migrateRetentionAt(storage: AlarmStorage): Promise<void> {
  const clock = retentionClock(storage);
  if ((await clock.getAlarm()) !== null) return;
  const current = await storage.getAlarm();
  if (current !== null && Number.isFinite(current)) await clock.setAlarm(current);
}

/** The alarm time wanted now: the retention due time, or sooner while a bridge is connected. */
export function wantedAlarm(retentionAt: number, bridgeConnected: boolean, now: number): number {
  return bridgeConnected ? Math.min(retentionAt, now + BRIDGE_CHECK_MS) : retentionAt;
}

/**
 * Sets the alarm to `wantedAlarm` unless one is already set at or before it (and still
 * in the future). `force` (the alarm handler) always sets it: the alarm that is running
 * may still read as set.
 */
export async function scheduleHubAlarm(storage: AlarmStorage, now: number, bridgeConnected: boolean, force = false): Promise<void> {
  await migrateRetentionAt(storage);
  const clock = retentionClock(storage);
  await ensureRetentionAlarm(clock, now);
  const retentionAt = (await clock.getAlarm()) ?? now;
  const want = wantedAlarm(retentionAt, bridgeConnected, now);
  const current = await storage.getAlarm();
  if (force || current === null || current > want || current <= now) await storage.setAlarm(want);
}

export interface HubAlarmDeps {
  readonly core: HubCore;
  readonly storage: AlarmStorage;
  readonly now: number;
  readonly log: Logger;
  /** Closes stale bridge sockets; returns whether a live bridge is still connected. */
  readonly checkBridge: (now: number) => boolean;
}

/** The alarm handler: bridge check, retention when due, then the next alarm. */
export async function runHubAlarm(d: HubAlarmDeps): Promise<void> {
  const connected = d.checkBridge(d.now);
  await migrateRetentionAt(d.storage);
  const clock = retentionClock(d.storage);
  const due = await clock.getAlarm();
  if (due === null || d.now >= due) await runRetentionAlarm(d.core, clock, d.now, d.log);
  await scheduleHubAlarm(d.storage, d.now, connected, true);
}
