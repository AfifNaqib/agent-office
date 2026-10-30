// Second redaction pass for receivers (plan §11, "runs in the emit script before
// leaving the machine and again in the relay"). Used by the bridge (POST
// /hooks/event) and the relay (POST /ingest), so both scrub the same way.
import { cleanName, redactText, scrubId } from './redact.js';
import { MAX_SUMMARY, MAX_TEXT, type OfficeEvent } from './schema.js';

const UNKNOWN = 'unknown';

function name(input: string, max: number): string {
  return cleanName(input, max) || UNKNOWN;
}

/** A repo name re-cleaned; dropped when nothing displayable is left. */
function cleanRepo(repo: string): string | undefined {
  const clean = cleanName(repo, 200);
  return clean === '' || clean === '.' || clean === '..' ? undefined : clean;
}

/**
 * Defence in depth: events are already scrubbed by the emit script, but a receiver
 * does not trust the sender. Runs the same core scrubbing over every free-text and
 * name field, and (B-09) over every id: an id holding a secret shape becomes
 * "redacted" (remoteSessionId and runId are dropped instead, as normalize does).
 * Idempotent on honest events (tested on all observed fixtures), so a clean event
 * comes out unchanged. Does not touch receivedAt or source: the receiver sets those.
 */
export function cleanEvent(e: OfficeEvent): OfficeEvent {
  const out: OfficeEvent = { ...e, sessionId: scrubId(e.sessionId) };
  const agentId = e.actor.agentId === null ? null : scrubId(e.actor.agentId);
  out.actor = { ...e.actor, agentType: e.actor.agentType === null ? null : name(e.actor.agentType, 100), agentId };
  if (e.remoteSessionId !== undefined && scrubId(e.remoteSessionId) !== e.remoteSessionId) delete out.remoteSessionId;
  // A bad runId is dropped, as normalize does (a run id only links to a bridge run).
  if (e.runId !== undefined && scrubId(e.runId) !== e.runId) delete out.runId;
  if (e.repo !== undefined) {
    const repo = cleanRepo(e.repo);
    if (repo === undefined) delete out.repo;
    else out.repo = repo;
  }
  if (e.text !== undefined) out.text = redactText(e.text, MAX_TEXT);
  if (e.tool) {
    out.tool = { ...e.tool, name: name(e.tool.name, 200), summary: redactText(e.tool.summary, MAX_SUMMARY) };
    if (e.tool.useId !== undefined) out.tool.useId = scrubId(e.tool.useId);
  }
  if (e.permission) {
    out.permission = {
      ...e.permission,
      requestId: scrubId(e.permission.requestId),
      toolName: name(e.permission.toolName, 200),
      summary: redactText(e.permission.summary, MAX_SUMMARY),
    };
  }
  return out;
}
