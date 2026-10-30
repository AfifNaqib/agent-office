// Prompt classification (S2 findings, fixture-refresh task). A UserPromptSubmit is
// not always the Product Owner typing: Claude Code also delivers its own messages
// through that hook. Pure and schema-free; reducers and normalize share it.

export const PROMPT_KINDS = ['po', 'handback', 'task-notification', 'side-session'] as const;
export type PromptKind = (typeof PROMPT_KINDS)[number];
export type SystemPromptKind = Exclude<PromptKind, 'po'>;

/**
 * Observed prefixes of system prompts (docs/spikes/S2.md, CLI 2.1.306 and Desktop app).
 * `tag` prefixes (XML-like) must end at a boundary (B-03): whitespace, `>` or the end
 * of the text, so `<agent-messages …` is a PO prompt. The side-session phrase is
 * matched exactly and only at the very start of the text, as observed.
 */
const SYSTEM_PREFIXES: readonly (readonly [SystemPromptKind, string, 'tag' | 'phrase'])[] = [
  ['handback', '<agent-message', 'tag'],
  ['task-notification', '<task-notification', 'tag'],
  ['side-session', 'Background (from the session that started this one)', 'phrase'],
];

/**
 * What goes on the wire instead of a system prompt's body: just its recognised
 * prefix. The body is a subagent report, a task result or a side-session brief,
 * not something the PO said, so there is no reason to forward it. The marker
 * still classifies as the same kind, so reducers need no extra field.
 */
export const SYSTEM_PROMPT_MARKER: Readonly<Record<SystemPromptKind, string>> = {
  handback: '<agent-message',
  'task-notification': '<task-notification',
  'side-session': 'Background (from the session that started this one)',
};

// BOM and leading whitespace do not change who wrote the prompt (JS \s includes U+FEFF).
const LEADING = /^\s+/;

/** True when `next` (the character after a tag, '' at the end) is whitespace or `>`. */
function atTagBoundary(next: string): boolean {
  return next === '' || /^[\s>]$/.test(next);
}

/** 'po' for anything that does not start with a known system prefix (also for empty/undefined). */
export function classifyPrompt(text: string | undefined): PromptKind {
  if (!text) return 'po';
  const head = text.replace(LEADING, '');
  for (const [kind, prefix, style] of SYSTEM_PREFIXES) {
    if (style === 'tag' ? head.startsWith(prefix) && atTagBoundary(head.charAt(prefix.length)) : text.startsWith(prefix)) return kind;
  }
  return 'po';
}

export function isSystemPrompt(text: string | undefined): boolean {
  return classifyPrompt(text) !== 'po';
}
