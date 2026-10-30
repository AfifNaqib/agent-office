// Pure helpers that put the Agent Office hook block into a Claude settings object
// and take it out again. No file access here.
//
// Marker: our hooks are exactly `{type:"command", command:"node", args:[<path>]}`
// where <path> ends in `agent-office-emit.mjs` (either slash). The installer never
// touches a hook that does not look like that, and re-runs replace ours in place
// instead of adding a second copy, even when the path changed (moved clone).
import { posix, win32 } from 'node:path';

export const EMIT_NAME = 'agent-office-emit.mjs';
export const PATH_PLACEHOLDER = '__AGENT_OFFICE_EMIT_PATH__';
const MARKER_RE = /(^|[\\/])agent-office-emit\.mjs$/;
// Same set the S3 spike refuses: a hook shell would expand $ ` % or end the quotes at ".
// Control characters (line breaks, NUL) are refused too.
// eslint-disable-next-line no-control-regex
const UNSAFE_PATH_RE = /["`$%\u0000-\u001f]/;

export function isOurHook(h) {
  return (
    h !== null &&
    typeof h === 'object' &&
    h.type === 'command' &&
    h.command === 'node' &&
    Array.isArray(h.args) &&
    h.args.length === 1 &&
    typeof h.args[0] === 'string' &&
    MARKER_RE.test(h.args[0])
  );
}

/** Throws a PO-readable error when `p` is not an absolute path made of plain characters. */
export function assertSafeEmitPath(p) {
  if (typeof p !== 'string' || !(posix.isAbsolute(p) || win32.isAbsolute(p))) {
    throw new Error(`The emit script path must be absolute: ${JSON.stringify(p)}`);
  }
  if (UNSAFE_PATH_RE.test(p)) {
    throw new Error(
      `This path has a character ($ % \` " or a line break) that a hook shell would expand: ${JSON.stringify(p)}. ` +
        'Set AGENT_OFFICE_HOME to a plain folder (for example C:\\Users\\<you>\\.agent-office) and run again.',
    );
  }
}

/** Deep copy of `template` with every PATH_PLACEHOLDER string replaced by `emitPath` (no JSON escaping by hand). */
export function fillTemplate(template, emitPath) {
  const fill = (v) => {
    if (v === PATH_PLACEHOLDER) return emitPath;
    if (Array.isArray(v)) return v.map(fill);
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  return fill(template);
}

/** Groups of one event without our hooks; a group that held only ours disappears, a mixed group keeps the rest. */
function stripOurs(groups) {
  let firstIndex = -1;
  let removed = 0;
  const kept = [];
  groups.forEach((g) => {
    const list = g !== null && typeof g === 'object' && Array.isArray(g.hooks) ? g.hooks : undefined;
    if (!list || !list.some(isOurHook)) {
      kept.push(g);
      return;
    }
    if (firstIndex < 0) firstIndex = kept.length;
    removed += list.filter(isOurHook).length;
    const rest = list.filter((h) => !isOurHook(h));
    if (rest.length > 0) kept.push({ ...g, hooks: rest });
  });
  return { kept, firstIndex, removed };
}

/**
 * `settings` with our hooks from `template` in place of any earlier copy of them.
 * Every other key and hook is kept as is. Our groups go where the old ones were
 * (so a re-run is stable), else at the end of that event's list. Returns a new object.
 */
export function mergeHooks(settings, template) {
  if (settings.hooks !== undefined && (settings.hooks === null || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) {
    throw new Error('"hooks" in the settings file is not an object; fix it by hand, nothing was changed');
  }
  for (const event of Object.keys(template.hooks)) {
    const have = settings.hooks?.[event];
    if (have !== undefined && !Array.isArray(have)) {
      throw new Error(`"hooks.${event}" in the settings file is not a list; fix it by hand, nothing was changed`);
    }
  }
  const hooks = { ...(settings.hooks ?? {}) };
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const { kept, firstIndex, removed } = stripOurs(groups);
    if (removed === 0) continue;
    const add = template.hooks[event];
    if (add) kept.splice(firstIndex, 0, ...add);
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  for (const [event, add] of Object.entries(template.hooks)) {
    const have = hooks[event];
    if (Array.isArray(have) && have.some((g) => Array.isArray(g?.hooks) && g.hooks.some(isOurHook))) continue; // placed above
    hooks[event] = [...(Array.isArray(have) ? have : []), ...add];
  }
  return { ...settings, hooks };
}

/** `settings` without any of our hooks. A `hooks` key that only held ours is removed too. Returns a new object. */
export function removeHooks(settings) {
  if (settings.hooks === null || typeof settings.hooks !== 'object') return { ...settings };
  const hooks = { ...settings.hooks };
  let removedAny = false;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const { kept, removed } = stripOurs(groups);
    if (removed === 0) continue;
    removedAny = true;
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  const next = { ...settings, hooks };
  if (removedAny && Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}

/** Our hooks in `settings` as sorted "Event [matcher] -> path" lines. */
export function listOurHooks(settings) {
  const out = [];
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
        if (isOurHook(h)) out.push(`${event}${typeof g.matcher === 'string' ? ` [${g.matcher}]` : ''} -> ${h.args[0]}`);
      }
    }
  }
  return out.sort();
}

/** Short human diff of our hooks before and after (other keys are never changed, so they are not listed). */
export function summarizeChange(before, after) {
  const a = listOurHooks(before);
  const b = listOurHooks(after);
  const lines = [];
  for (const l of b) if (!a.includes(l)) lines.push(`+ ${l}`);
  for (const l of a) if (!b.includes(l)) lines.push(`- ${l}`);
  return lines;
}
