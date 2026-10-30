// HubApi over the OfficeHub Durable Object stub (RPC + fetch for the WebSocket
// upgrade). Shared by the Worker entry and the workerd test entry.
import type { OfficeHub } from './hub.js';
import type { HubApi } from './types.js';
import { bridgeUpgradeRequest } from './bridgeSockets.js';
import { uiUpgradeRequest } from './uiSockets.js';

/** Single user, single hub (plan §5). */
export const HUB_NAME = 'office';

export function hubClient(ns: DurableObjectNamespace<OfficeHub>): HubApi {
  const stub = ns.get(ns.idFromName(HUB_NAME));
  return {
    ingest: (event) => stub.ingest(event),
    sessions: () => stub.sessions(),
    events: (after, limit) => stub.events(after, limit),
    sessionEvents: (key, after, limit) => stub.sessionEvents(key, after, limit),
    health: () => stub.health(),
    // A WebSocket upgrade goes through the DO's fetch (RPC cannot carry it).
    connectUi: (request, expMs) => stub.fetch(uiUpgradeRequest(request, expMs)),
    connectBridge: (request) => stub.fetch(bridgeUpgradeRequest(request)),
  };
}
