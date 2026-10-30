// Redaction (plan §11). Runs in the emit script before data leaves the machine
// and again in the relay. Every function here is pure and idempotent:
// redact(redact(x)) === redact(x).
import { MAX_SUMMARY, MAX_TEXT } from './schema.js';

export const REDACTED = '[redacted]';

export const SUMMARY_LIMITS = {
  pattern: 40,
  query: 60,
  description: 80,
} as const;

const ELLIPSIS = '…';

/**
 * Longest input the scrub rules ever see (BUG-01). Longer text is cut first, so
 * the cost of every rule is bounded no matter how big a prompt or tool input is.
 * Outputs are capped at 500 or less, so nothing past this point could be shown.
 */
export const SCRUB_INPUT_MAX = 8 * 1024;
/** When the cut lands inside a word shorter than this, the partial word is dropped. */
const TAIL_DROP_MAX = 512;
/** Shell summaries only look at the start of the command (BUG-01). */
const SHELL_HEAD_MAX = 1024;
const SHELL_TOKENS = 2;

// Every rule below is linear-time: each one either starts only at the beginning
// of a run (lookbehind) or uses bounded repeats, so no rule can backtrack over
// the whole input (BUG-01). Order matters: invisible characters are stripped
// first, then multi-line blocks and structured forms, then token prefixes, then
// the generic long-run and phone rules.

// Zero-width, soft hyphen, bidi controls, the combining grapheme joiner (U+034F)
// and Hangul/Khmer fillers can split a token so no rule sees it (BUG-03, NB-03).
// ZWJ and the invisible tag characters (U+E0000-E007F) are only stripped next to
// ASCII, so emoji sequences and subdivision flags survive. Combining marks are
// alternatives, not class members (no-misleading-character-class).
const INVISIBLE =
  /\u034f|\u17b4|\u17b5|[\u00ad\u061c\u115f\u1160\u180e\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u3164\ufeff\uffa0]|(?<=[\x21-\x7e])(?:\u200d|\udb40[\udc00-\udc7f])|(?:\u200d|\udb40[\udc00-\udc7f])(?=[\x21-\x7e])/g;
// Horizontal space as a separator: ASCII plus NBSP, the U+2000 spaces, narrow NBSP,
// medium math space and the ideographic space (NB-03). Used inside character classes.
const SP = ' \\t\\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000';
// Assignment operators: "=", ":", fullwidth "＝" / "：", and ":=" / "=>" (NB-03).
const ASSIGN = `(?::=|=>|[:=\\uff1a\\uff1d])`;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]{0,40}KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}KEY(?: BLOCK)?-----|$)/g;
// userinfo: "user:password@" up to the LAST '@' before the host (passwords may
// hold '/', '#', '@'; the user part may hold '/' too, NB-03), or a bare "token@".
const URL_USERINFO =
  /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/)(?:[^\s:?#@]{0,128}:[^\s"'<>]{0,256}|[^\s/?#@]{1,256})@/gi;
const AUTH_HEADER = new RegExp(
  `\\b(authorization["']?[${SP}]*${ASSIGN}[${SP}]*["']?)(?:(basic|bearer|token|digest|negotiate|ntlm)[${SP}]+)?[^\\s"',;]+`,
  'gi',
);
// A Cookie / Set-Cookie header ("cookie:" with no quote before the colon): the whole value up to the end of the
// line or a quote, since it holds several "name=value;" pairs (NB-03). A value longer than the
// 4096 bound runs on to the end of the line, so nothing past the cut is left (V1-00-2).
const COOKIE_MAX = 4096;
const COOKIE_HEADER = new RegExp(
  `(?<![\\w-])((?:set-)?cookie[${SP}]*[:\\uff1a][${SP}]*)` +
    `([^\\r\\n"']{${COOKIE_MAX}}[^\\r\\n]*|[^\\r\\n"']{1,${COOKIE_MAX - 1}})`,
  'gi',
);
// curl cookies on the command line (V1-00-3): `--cookie <v>` / `--cookie=<v>` always, and
// `-b <v>` only when the value holds "name=value" (a bare `-b` value is a cookie file, or
// another tool's -b flag such as `git checkout -b`). Quoted values stop at either quote;
// an unterminated one runs to the end of the line (bounded).
const CURL_COOKIE = new RegExp(
  `(?<![\\w-])(--cookie(?:[${SP}]+|=)|-b[${SP}]*)` +
    `(?:'([^'"\\n]{0,1024})'?|"([^'"\\n]{0,1024})"?|([^\\s"']{1,1024}))`,
  'g', // curl flags are case-sensitive (-B is another flag)
);
const BEARER = /\bBearer\s+\S+/gi;
const BASIC = new RegExp(`\\bBasic[${SP}]+(?=[A-Za-z0-9+/]*[0-9+/])[A-Za-z0-9+/]{8,}={0,2}`, 'g');
// key=value / key: value where the key names a secret. The lookahead keeps the
// match from starting (and consuming a value) unless the key is a secret one.
// Bare pass/pwd/auth/cookie only count as whole words (not bypass, author) (NB-03).
const BARE_KEY = '(?:pass|pwd|auth|cookie)';
const SECRET_KEY =
  '(?:password|passwd|secret|token|api[_-]?key|private[_-]?key' +
  `|(?<![a-z0-9])${BARE_KEY}(?![a-z])` +
  '|[_.-](?:pass|pwd|pw|key|credentials?|auth|cookie)(?![a-z]))';
// Separator: optional closing quote, an assignment operator, then optionally a
// newline (value on the next line) or a YAML block indicator (| > |- >+) and a newline.
const KV_SEP =
  `(["']?[${SP}]*${ASSIGN}[${SP}]*` +
  `(?:[|>][+-]?[${SP}]*\\r?\\n[${SP}]*|\\r?\\n[${SP}]*)?)`;
// Value: "...", '...', $'...' (bash), `...`, or a bare word.
const KV_VALUE = '(?:\\$?"([^"\\n]*)"?|\\$?\'([^\'\\n]*)\'?|`([^`\\n]*)`?|(?![=:…])([^\\s"\'`}]+))';
const KEY_VALUE = new RegExp(`(?<![\\w.-])(?=[\\w.-]{0,200}?${SECRET_KEY})([\\w.-]{1,200})${KV_SEP}${KV_VALUE}`, 'gi');
const JWT = /(?<![\w-])eyJ[\w-]{2,}\.[\w-]{2,}(?:\.[\w-]*)?/g;
const ANTHROPIC = /sk-ant-[A-Za-z0-9_-]+/g;
const STRIPE = /\b[rs]k_(?:live|test)_[A-Za-z0-9]+/g;
const GITHUB = /\b(?:gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)/g;
const AWS_KEY_ID = /\b(?:AKIA|ASIA|AIDA|AROA|AGPA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/g;
const LONG_RUN = /[A-Za-z0-9+/=_-]{32,}/g;
// Starts only at a word boundary, so digits inside UUIDs or ids are not phones.
const PHONE = /(?<![\w.-])\+?\d[\d\s-]{8,}\d/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A date, or the "YYYY-MM-DD HH" a phone match takes from "YYYY-MM-DD HH:MM" (BUG-12). */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2})?$/;

/**
 * Decide whether a run of >= 32 base64/hex-like characters is a secret.
 * Kept: runs with no digit (long words, snake_case names, digit-free paths),
 * UUIDs, and slash paths that are not mixed-case alphanumeric (e.g.
 * packages/core/v2/x). Redacted: hex with digits, mixed upper+lower+digit, and
 * digit+letter runs without a slash (base64url tokens).
 */
function isSecretLike(run: string): boolean {
  const hasDigit = /\d/.test(run);
  if (!hasDigit) return false;
  if (UUID.test(run)) return false;
  const hasLetter = /[A-Za-z]/.test(run);
  if (/^[0-9a-fA-F-]+$/.test(run)) return true;
  if (/[A-Z]/.test(run) && /[a-z]/.test(run)) return true;
  return hasLetter && !run.includes('/');
}

/** `max_tokens=4000`-style counts are settings, not secrets (BUG-12). */
function isCount(key: string, value: string): boolean {
  return /tokens$/i.test(key) && /^\d{1,9}$/.test(value);
}

/**
 * The bare words pass/auth/cookie/pwd also name things that are not secrets
 * ("pass: 42", "auth: true"): a small number or a flag word is kept for them.
 */
function isBareFlag(key: string, value: string): boolean {
  return (
    new RegExp(`^${BARE_KEY}$`, 'i').test(key) &&
    /^(?:\d{1,9}|true|false|null|none|yes|no|on|off|ok|required|optional)[,;.)]?$/i.test(value)
  );
}

function redactKeyValue(
  m: string,
  key: string,
  sep: string,
  dq?: string,
  sq?: string,
  bq?: string,
  bare?: string,
): string {
  const value = dq ?? sq ?? bq ?? bare ?? '';
  if (value === '' || isCount(key, value) || isBareFlag(key, value)) return m;
  // Keep a "$" that opened a $'...' / $"..." value, so the output is idempotent.
  const dollar = m.charAt(key.length + sep.length) === '$' ? '$' : '';
  const q = dq !== undefined ? '"' : sq !== undefined ? "'" : bq !== undefined ? '`' : '';
  return `${key}${sep}${dollar}${q}${REDACTED}${q}`;
}

function redactCookieHeader(m: string, prefix: string, value: string): string {
  return isBareFlag('cookie', value.trim()) ? m : `${prefix}${REDACTED}`;
}

function redactCurlCookie(m: string, flag: string, sq?: string, dq?: string, bare?: string): string {
  const value = sq ?? dq ?? bare ?? '';
  if (value === '' || value === REDACTED || value === ELLIPSIS || (flag.startsWith('-b') && !value.includes('='))) return m;
  const q = sq !== undefined ? "'" : dq !== undefined ? '"' : '';
  return `${flag}${q}${REDACTED}${q}`;
}

function stripInvisible(input: string): string {
  return input.replace(INVISIBLE, '');
}

/**
 * The rules for known secret shapes (key blocks, userinfo, headers, key=value,
 * token prefixes). It leaves out the two guesses (long runs, phone numbers) that
 * real ids would trip, so ids can be checked with it (scrubId, B-09).
 */
function scrubKnown(input: string): string {
  return stripInvisible(input)
    .replace(PRIVATE_KEY_BLOCK, REDACTED)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(AUTH_HEADER, (_m, prefix: string, scheme: string | undefined) =>
      scheme ? `${prefix}${scheme} ${REDACTED}` : `${prefix}${REDACTED}`,
    )
    .replace(COOKIE_HEADER, redactCookieHeader)
    .replace(CURL_COOKIE, redactCurlCookie)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(BASIC, `Basic ${REDACTED}`)
    .replace(KEY_VALUE, redactKeyValue)
    .replace(JWT, REDACTED)
    .replace(ANTHROPIC, REDACTED)
    .replace(STRIPE, REDACTED)
    .replace(GITHUB, REDACTED)
    .replace(AWS_KEY_ID, REDACTED);
}

/** Replace secret-looking content with [redacted]. Does not truncate; callers bound the input (capRedacted). */
export function scrubText(input: string): string {
  return scrubKnown(input)
    .replace(LONG_RUN, (run) => (isSecretLike(run) ? REDACTED : run))
    .replace(PHONE, (m) => (ISO_DATE.test(m) ? m : REDACTED));
}

/** What an id that holds a secret shape is replaced with. Fits every id charset. */
export const REDACTED_ID = 'redacted';
/** Ids are short (schema max 200); anything longer is not an id. */
const MAX_ID_SCRUB = 256;

/**
 * B-09: an id (sessionId, runId, agentId, useId, requestId, remoteSessionId) is
 * kept as is unless it holds a known secret shape (token prefix, key=value, JWT,
 * userinfo, invisible characters...), in which case the WHOLE id becomes
 * REDACTED_ID, so the id keeps a safe charset. The long-run and phone guesses are
 * not used: real ids (UUIDs, toolu_..., 64-hex request ids, cse_...) look like them.
 * Idempotent. Real ids (S2 fixtures, cloud UUIDs and cse_ ids) are unchanged.
 */
export function scrubId(id: string): string {
  if (id.length > MAX_ID_SCRUB) return REDACTED_ID;
  return scrubKnown(id) === id ? id : REDACTED_ID;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

/**
 * Cut `input` to SCRUB_INPUT_MAX before scrubbing. A cut inside a short word drops
 * that word, so half a secret (too short for the long-run rule) is never kept.
 */
export function boundForScrub(input: string, max: number = SCRUB_INPUT_MAX): string {
  if (input.length <= max) return input;
  let end = max;
  if (isHighSurrogate(input.charCodeAt(end - 1))) end -= 1;
  let cut = end;
  if (!isSpace(input[end])) {
    const floor = Math.max(0, end - TAIL_DROP_MAX);
    let i = end;
    while (i > floor && !isSpace(input[i - 1])) i -= 1;
    if (isSpace(input[i - 1])) cut = i; // else: one huge run, judged whole by LONG_RUN
  }
  return input.slice(0, cut) + ELLIPSIS;
}

/** Cut to at most `max` UTF-16 units, ending in "…" when cut. Never splits a surrogate pair. */
export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  if (max <= 0) return '';
  let end = max - 1;
  const code = input.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return input.slice(0, end) + ELLIPSIS;
}

/**
 * Scrub, then cap, repeated until nothing changes. A cut can land inside a
 * "[redacted]" marker or drop the "/" that made a long run look like a path,
 * so one pass is not always idempotent. Converges in 1-2 passes in practice.
 */
export function capRedacted(input: string, max: number): string {
  let cur = boundForScrub(input);
  for (let i = 0; i < 4; i++) {
    const next = truncate(scrubText(cur), max);
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

/** Free text (prompt, last_assistant_message, notification): scrub, then cap at 500. */
export function redactText(input: string, max: number = MAX_TEXT): string {
  return capRedacted(input, max);
}

// C0/C1 controls and bidi overrides: never part of a repo or display name (BUG-08).
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/**
 * A name for display (agent type, tool name, repo): controls removed, scrubbed,
 * capped. MCP names ("mcp__server__tool") are scrubbed per "__" part, so a long
 * but harmless name (mcp__plugin_ec2__DescribeInstances) is not one "long run".
 */
export function cleanName(input: string, max: number): string {
  const parts = boundForScrub(input).replace(UNSAFE_NAME_CHARS, '').split('__');
  return truncate(parts.map((part) => capRedacted(part, max)).join('__'), max);
}

function toSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

/** basename(cwd) only, never the full path. Returns undefined when empty. */
export function repoName(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const parts = toSlashes(cwd).split('/').filter(Boolean);
  const base = parts.at(-1);
  if (!base) return undefined;
  const clean = cleanName(base, 200);
  if (clean === '.' || clean === '..') return undefined;
  return clean.length > 0 ? clean : undefined;
}

/** Path relative to cwd (when inside it), last 2 segments, forward slashes. */
export function shortPath(path: string, cwd?: string): string {
  let p = toSlashes(path);
  if (cwd) {
    const base = toSlashes(cwd).replace(/\/+$/, '');
    const windows = /^[A-Za-z]:/.test(base);
    const inside = windows
      ? p.toLowerCase().startsWith(`${base.toLowerCase()}/`)
      : p.startsWith(`${base}/`);
    if (base.length > 0 && inside) p = p.slice(base.length + 1);
  }
  return p.split('/').filter(Boolean).slice(-2).join('/');
}

function field(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

// Leading `VAR=value` / PowerShell `$env:VAR=value`, and `NAME=value` arguments.
const ASSIGNMENT = /^(\$?[A-Za-z_][\w:]{0,100})=/;
// `--password=x`, `-o=x`
const FLAG_VALUE = /^(--?[A-Za-z][\w-]{0,100})=/;
// `mysql -phunter2`, `curl -uuser:pw`, `sshpass -phunter2`, `curl -bsid=x`: value glued to -p / -u / -b.
const GLUED_CRED_FLAG = /^(-[pub])\S/;
// Commands whose arguments are printed text, so they are never shown.
const PRINT_COMMANDS = new Set(['echo', 'printf', 'print', 'write-host', 'write-output', 'write-information']);

function commandName(token: string): string {
  return (token.split(/[\\/]/).at(-1) ?? token).toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, '');
}

function shellArg(token: string): string {
  const glued = GLUED_CRED_FLAG.exec(token);
  if (glued) return `${glued[1]}${ELLIPSIS}`;
  const flag = FLAG_VALUE.exec(token) ?? ASSIGNMENT.exec(token);
  if (flag) return `${flag[1]}=${ELLIPSIS}`;
  return token;
}

interface ShellToken {
  readonly text: string;
  /** The token ran into a quote that never closes (within the head). */
  readonly open: boolean;
}

/** Quoting rules: bash (\\ escapes; ' " $' ` quote) or PowerShell (` escapes; ' " quote). */
type ShellDialect = 'sh' | 'pwsh';

/** The quote a character at `i` opens, how many characters the opener takes, and whether escapes apply inside. */
function quoteAt(head: string, i: number, dialect: ShellDialect): { close: string; skip: number; escapes: boolean } | undefined {
  const ch = head[i];
  if (ch === "'") return { close: "'", skip: 1, escapes: false };
  if (ch === '"') return { close: '"', skip: 1, escapes: true };
  if (dialect === 'sh' && ch === '`') return { close: '`', skip: 1, escapes: true };
  if (dialect === 'sh' && ch === '$' && head[i + 1] === "'") return { close: "'", skip: 2, escapes: true };
  return undefined;
}

/**
 * V1-00-1: split the head of a command into words the way a shell does, so a quoted
 * value with spaces ('…', "…", $'…', `…`) stays inside its word. The escape
 * character (\\ in bash, ` in PowerShell) skips the next character. One pass over
 * the input (linear): every character is looked at once. A word with an
 * unterminated quote is the last one.
 */
function* shellTokens(head: string, dialect: ShellDialect): Generator<ShellToken> {
  const esc = dialect === 'sh' ? '\\' : '`';
  const n = head.length;
  let i = 0;
  while (i < n) {
    while (i < n && isSpace(head[i])) i += 1;
    if (i >= n) return;
    const start = i;
    let open = false;
    while (i < n && !isSpace(head[i])) {
      const q = quoteAt(head, i, dialect);
      if (q === undefined) {
        i += head[i] === esc ? 2 : 1;
        continue;
      }
      i += q.skip;
      while (i < n && head[i] !== q.close) i += q.escapes && head[i] === esc ? 2 : 1;
      if (i >= n) {
        open = true;
        break;
      }
      i += 1; // the closing quote
    }
    yield { text: head.slice(start, Math.min(i, n)).replace(/\s+/g, ' '), open };
    if (open) return;
  }
}

/**
 * BUG-01/02: first SHELL_TOKENS words of the command, taken from the start of
 * the raw command (never the whole thing), with values that could be credentials
 * replaced by "…": leading VAR=value, --flag=value, NAME=value, -p<pw>, -u<user:pw>,
 * -b<cookie>, and every argument of echo/printf/Write-Host. Quoted values with
 * spaces stay in their word (V1-00-1); a word with an unterminated quote is kept
 * only when its value is hidden anyway (assignment or credential flag), and
 * nothing after it is shown. The result is scrubbed afterwards.
 */
export function shellSummary(command: string, dialect: ShellDialect = 'sh'): string {
  const head = stripInvisible(command.slice(0, SHELL_HEAD_MAX));
  const out: string[] = [];
  let seenCommand = false;
  for (const { text: token, open } of shellTokens(head, dialect)) {
    if (out.length >= SHELL_TOKENS) break;
    if (!seenCommand) {
      const env = ASSIGNMENT.exec(token);
      if (env) {
        out.push(`${env[1]}=${ELLIPSIS}`);
        continue;
      }
      if (open) break;
      seenCommand = true;
      out.push(token);
      if (PRINT_COMMANDS.has(commandName(token))) break;
      continue;
    }
    const arg = shellArg(token);
    if (open && arg === token) break;
    out.push(arg);
  }
  return out.join(' ');
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);

function rawSummary(toolName: string, input: unknown, cwd?: string): string {
  if (FILE_TOOLS.has(toolName)) {
    const p = field(input, 'file_path') ?? field(input, 'notebook_path');
    // The end of the path is what is shown, so a huge path keeps its tail.
    return p ? shortPath(scrubText(p.length > SCRUB_INPUT_MAX ? p.slice(-SCRUB_INPUT_MAX) : p), cwd) : '';
  }
  if (SHELL_TOOLS.has(toolName)) {
    const c = field(input, 'command');
    return c ? shellSummary(c, toolName === 'PowerShell' ? 'pwsh' : 'sh') : '';
  }
  if (toolName === 'Grep' || toolName === 'Glob') {
    return capRedacted(field(input, 'pattern') ?? '', SUMMARY_LIMITS.pattern);
  }
  if (toolName === 'WebFetch') {
    return hostname(field(input, 'url') ?? '');
  }
  if (toolName === 'ToolSearch') {
    // "select:WebFetch" or keywords: the lookup, capped like a search pattern.
    return capRedacted(field(input, 'query') ?? '', SUMMARY_LIMITS.pattern);
  }
  if (toolName === 'WebSearch') {
    return capRedacted(field(input, 'query') ?? '', SUMMARY_LIMITS.query);
  }
  if (AGENT_TOOLS.has(toolName)) {
    const type = field(input, 'subagent_type');
    const desc = capRedacted(field(input, 'description') ?? '', SUMMARY_LIMITS.description);
    const t = type ? capRedacted(type, 100) : '';
    return t ? (desc ? `${t}: ${desc}` : t) : desc;
  }
  // SubagentHandback carries a whole report in tool_input.message: never kept (S2).
  // MCP tools (mcp__server__tool) and anything unknown: tool name only, which
  // travels in tool.name. Nothing from the input is kept.
  return '';
}

/** Redacted one-line tool summary (≤ 120). Raw tool_input never leaves this function. */
export function summarizeTool(toolName: string, input: unknown, cwd?: string): string {
  return capRedacted(rawSummary(toolName, input, cwd), MAX_SUMMARY);
}
