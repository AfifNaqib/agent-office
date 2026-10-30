// Types shared by the Worker routes. Kept free of Workers globals so the routes
// run under plain Node in tests; worker.ts binds them to the real DO stub.
import type { AccessBindings } from './auth/access.js';
import type { EventsPage, IngestResult, SessionsPage } from './hubCore.js';

/** What a route needs from the OfficeHub Durable Object (RPC methods + the UI socket fetch). */
export interface HubApi {
  ingest(event: unknown): Promise<IngestResult>;
  sessions(): Promise<SessionsPage>;
  events(after: number, limit: number): Promise<EventsPage>;
  /** Null for an unknown session. */
  sessionEvents(key: string, after: number, limit: number): Promise<EventsPage | null>;
  health(): Promise<HubHealth>;
  /**
   * Hands a checked WebSocket upgrade to the DO (101 + socket, or an error
   * response). `expMs` = the Access JWT's exp: the socket is closed after it.
   */
  connectUi(request: Request, expMs: number): Promise<Response>;
  /** Hands a bridge upgrade that passed the BRIDGE_TOKEN check to the DO (101 + socket, V1-04). */
  connectBridge(request: Request): Promise<Response>;
}

export interface HubHealth {
  readonly events7d: number;
  /** A bridge socket is open and answered a ping within BRIDGE_STALE_MS (V1-04). */
  readonly bridgeOnline: boolean;
}

/** Set by the Access guard on every protected path it lets through. */
export interface AccessInfo {
  readonly email: string;
  readonly expMs: number;
}

/** Worker bindings the routes read. HUB is resolved through RelayDeps.hub. */
export interface RelayBindings extends AccessBindings {
  /** Secret (wrangler secret put INGEST_TOKEN). Missing or short -> /ingest answers 503. */
  readonly INGEST_TOKEN?: string;
  /** Secret (wrangler secret put BRIDGE_TOKEN). Missing or short -> /bridge answers 503 (V1-04). */
  readonly BRIDGE_TOKEN?: string;
  /** Workers static assets binding (wrangler.jsonc `assets.binding`): the built web app. Missing -> the UI routes answer 503. */
  readonly ASSETS?: AssetsFetcher;
}

/** The part of the Workers `Fetcher` the UI routes use (kept free of Workers globals for the Node tests). */
export interface AssetsFetcher {
  fetch(request: Request): Promise<Response>;
}

export type RelayEnv<B extends RelayBindings = RelayBindings> = { Bindings: B; Variables: { access?: AccessInfo } };

export function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}
