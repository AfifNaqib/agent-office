// Tool name -> avatar activity (FR-008).

export const ACTIVITIES = [
  'idle',
  'working',
  'reading',
  'typing',
  'running',
  'browsing',
  'delegating',
  'waiting',
  'done',
  'error',
] as const;
export type Activity = (typeof ACTIVITIES)[number];

const TOOL_ACTIVITY: Readonly<Record<string, Activity>> = {
  Read: 'reading',
  Glob: 'reading',
  Grep: 'reading',
  Edit: 'typing',
  Write: 'typing',
  NotebookEdit: 'typing',
  Bash: 'running',
  PowerShell: 'running',
  WebFetch: 'browsing',
  WebSearch: 'browsing',
  Agent: 'delegating',
  Task: 'delegating', // older name of the Agent tool
};

/** Activity shown while a tool runs. Unknown and MCP tools -> "working". */
export function toolActivity(toolName: string): Activity {
  return Object.hasOwn(TOOL_ACTIVITY, toolName) ? (TOOL_ACTIVITY[toolName] ?? 'working') : 'working';
}

/** The tool a subagent calls to hand its report back. Its input is a whole report (S2). */
export const HANDBACK_TOOL = 'SubagentHandback';
/** What the feed and office show for a hand-back instead of any report text. */
export const HANDBACK_LABEL = 'reporting back';

/**
 * One-line text for a tool call: "<name> <summary>", except a hand-back, which is
 * always "reporting back" (whatever summary an emitter sent, the report is never shown).
 */
export function toolDisplay(name: string, summary: string): string {
  if (name === HANDBACK_TOOL) return HANDBACK_LABEL;
  return summary ? `${name} ${summary}` : name;
}
