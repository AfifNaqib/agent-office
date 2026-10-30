// Which server the page came from (V1-05). The PC bridge injects the local token
// meta tag; the relay injects `<meta name="agent-office-mode" content="relay">`
// (packages/relay/src/routes/assets.ts). Neither (Vite dev, a file) = demo.
import type { LiveStatus } from './live.js';

export const TOKEN_META = 'agent-office-token';
export const MODE_META = 'agent-office-mode';

export type PageMode = { kind: 'bridge'; token: string } | { kind: 'relay' } | { kind: 'demo' };

interface MetaSource {
  querySelector(selector: string): { getAttribute(name: string): string | null } | null;
}

export function pageMode(doc: MetaSource): PageMode {
  const token = doc.querySelector(`meta[name="${TOKEN_META}"]`)?.getAttribute('content');
  if (token) return { kind: 'bridge', token };
  if (doc.querySelector(`meta[name="${MODE_META}"]`)?.getAttribute('content') === 'relay') return { kind: 'relay' };
  return { kind: 'demo' };
}

/**
 * The status line for a live page. `where` describes the shown session. `pcBridge`
 * (relay only, V1-04): whether the PC bridge is connected to the relay; undefined = not known yet.
 */
export function liveStatusText(server: 'bridge' | 'relay', link: LiveStatus, where: string, pcBridge?: boolean): string {
  switch (link) {
    case 'live': {
      if (server !== 'relay') return `● LIVE  ${where}`;
      const pc = pcBridge === undefined ? '' : pcBridge ? ' · PC on' : ' · PC off';
      return `● LIVE · relay${pc}  ${where}`;
    }
    case 'offline':
      return server === 'relay' ? '○ relay offline, retrying' : '○ bridge offline, retrying';
    case 'login':
      return '○ login expired';
    case 'replaced':
      return '○ paused: opened in a newer tab';
    case 'connecting':
      return '○ connecting';
  }
}
