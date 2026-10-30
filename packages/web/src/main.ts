// Office view entry. Three modes, picked from the page's meta tags (mode.ts):
// - served by the PC bridge (token meta): live from the bridge, following your newest session;
// - served by the relay (mode meta "relay", V1-05): live from the relay over the Access login;
// - opened any other way (Vite dev): the scripted demo run, looping.
// All feed the same Follower, office and panel.
// The relay CSP (script-src 'self', no 'unsafe-eval', R-1): csp.ts turns off zod's
// eval probe; Pixi 8 builds shader/uniform code with new Function() unless
// `pixi.js/unsafe-eval` is loaded. Both before any other module runs.
import './csp.js';
import 'pixi.js/unsafe-eval';
import './style.css';
import { Application, Text } from 'pixi.js';
import type { OfficeState } from '@agent-office/core';
import { DEMO_LOOP_S, demoEvents } from './demo.js';
import { Follower } from './follow.js';
import { connectLocal, connectRelay, type LiveDeps, type LiveHandlers, type LiveStatus } from './live.js';
import { liveStatusText, pageMode } from './mode.js';
import { OfficeScene, type OfficeStats } from './office/scene.js';
import { pickResolution } from './office/view.js';
import { Panel } from './panel.js';

/** History requests time out, so a hung server cannot leave the page on "connecting" forever. */
const FETCH_TIMEOUT_MS = 15_000;

const byId = (id: string): HTMLElement => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} missing`);
  return e;
};
const officeEl = byId('office');
const statusEl = byId('status');

const app = new Application();
// HiDPI: draw at the device pixel ratio (capped, see pickResolution); CSS size stays the pane size (autoDensity).
const resolutionNow = (): number => pickResolution(window.devicePixelRatio, officeEl.clientWidth, officeEl.clientHeight);
await app.init({ resizeTo: officeEl, resolution: resolutionNow(), autoDensity: true, background: 0x0a0a0b, antialias: false, roundPixels: true });
officeEl.appendChild(app.canvas);
// Moving the window to another screen changes the ratio: re-render at the new one (the scene refits on the renderer's resize event).
const syncResolution = (): void => {
  const r = resolutionNow();
  if (r !== app.renderer.resolution) app.renderer.resize(app.screen.width, app.screen.height, r);
};
const watchRatio = (): void => {
  const q = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  q.addEventListener(
    'change',
    () => {
      syncResolution();
      watchRatio();
    },
    { once: true },
  );
};
window.addEventListener('resize', syncResolution);
watchRatio();

const scene = new OfficeScene(app);
const params = new URLSearchParams(location.search);
const follower = new Follower();
const panel = new Panel(byId('lobby'), byId('feed'), byId('announce'), (key) => {
  follower.pin(key);
});

// ?fps shows the frame rate (V0-04 AC: 30 fps with 6 walking avatars).
const fps = params.has('fps')
  ? app.stage.addChild(new Text({ text: '', style: { fontFamily: 'monospace', fontSize: 12, fill: 0xff2d2d } }))
  : null;

let state: OfficeState = follower.advance(Date.now());
// Test hook (V0-05, Playwright): window.__office.state() / stats(). Only with ?debug, so a normal page exposes nothing.
if (params.has('debug')) {
  (window as unknown as { __office: { state: () => OfficeState; stats: () => OfficeStats; panel: Panel } }).__office = {
    panel,
    state: () => state,
    stats: () => scene.stats(),
  };
}

const mode = pageMode(document);
let statusText: (where: string) => string;

if (mode.kind !== 'demo') {
  let link: LiveStatus = 'connecting';
  let pcBridge: boolean | undefined;
  const relogin = byId('relogin');
  const handlers: LiveHandlers = {
    onEvent: (e) => {
      follower.push(e, Date.now());
    },
    onReset: () => {
      follower.reset();
    },
    onStatus: (s) => {
      link = s;
      // Final states offer a reload (Access shows its login page when the session is gone).
      relogin.hidden = s !== 'login' && s !== 'replaced';
      relogin.textContent = s === 'replaced' ? 'Reconnect' : 'Log in again';
    },
    onBridge: (online) => {
      pcBridge = online;
    },
  };
  // The DOM WebSocket's handler types are wider than MiniSocket's; the client only uses the subset.
  const deps: LiveDeps = {
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
    WebSocket: WebSocket as unknown as LiveDeps['WebSocket'],
    setTimeout: (fn, ms) => setTimeout(fn, ms),
  };
  const wsBase = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  if (mode.kind === 'bridge') connectLocal({ http: '', ws: wsBase }, mode.token, handlers, deps);
  else connectRelay({ http: '', ws: wsBase }, handlers, deps);
  const server = mode.kind;
  statusText = (where) => liveStatusText(server, link, where, pcBridge);
} else {
  // Demo: replay the scripted run on the real clock, starting ?t=<seconds> in.
  const script = demoEvents();
  let base = Date.now() - Number(params.get('t') ?? 0) * 1000;
  let next = 0;
  setInterval(() => {
    const now = Date.now();
    if (now - base > DEMO_LOOP_S * 1000) {
      base = now;
      next = 0;
      follower.reset();
    }
    while (next < script.length && base + (script[next]?.emittedAt ?? Infinity) <= now) {
      const e = script[next++];
      if (e) follower.push({ ...e, emittedAt: base + e.emittedAt }, now);
    }
  }, 100);
  statusText = (where) => `DEMO  ${where}  (open the bridge address for your live office)`;
}

let shown: string | null = null;
app.ticker.add((ticker) => {
  const now = Date.now();
  state = follower.advance(now);
  if (follower.shownKey !== shown) {
    shown = follower.shownKey;
    scene.reset(); // the other session's visitors must not linger
  }
  scene.update(state, ticker.deltaMS, performance.now());
  const s = follower.current(now);
  statusEl.textContent = statusText(s ? `${s.repo ?? s.sessionId} · ${s.source === 'local' ? 'PC' : 'Cloud'} · ${s.status}` : 'no sessions yet');
  panel.renderLobby(follower.lobby(now), shown, follower.pinnedKey, now);
  panel.renderFeed(follower.feed, s, now);
  if (fps) fps.text = `${Math.round(ticker.FPS)} fps`;
});
