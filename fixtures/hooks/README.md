# Hook payload fixtures

| Folder | Status | Origin |
|---|---|---|
| `pc/` | **OBSERVED** (real, 2026-10-21) | Windows PC, Claude Code CLI 2.1.306, `--permission-mode auto`. One session with `architect` and `tester` subagents (35 files; each prompt/session event appears in exec and shell form). |
| `pc2/` | **OBSERVED** (real, 2026-10-21) | Windows PC, CLI 2.1.306, default permission mode: `PermissionRequest`, `Notification`, `PostToolUseFailure` (13 files). |
| `pc-desktop/` | **OBSERVED** (real, 2026-10-21) | Windows PC, Claude Desktop app, ask-permission mode. Two sessions in one folder: the PO's session (architect subagent, permission, failing Bash, `<task-notification>` prompt) and a hidden side session (26 files). |
| `cloud/` | **OBSERVED** (real, 2026-10-25) | Claude Code cloud session (linux, Node v22.22.0), `--permission-mode auto`. One session with `architect` and `tester` subagents, WebFetch, a resume and a cross-session message (`ReadNotifications`) (46 files; SessionStart/UserPromptSubmit in exec and shell form). Imported in V1-S2c from `spike/s2-capture` commit 487f619. Contract tests run them with `source: 'cloud'` and a fake `cse_` remote id (the capture kept env var presence only). Not seen in cloud: `PermissionRequest`, `Notification`, `PostToolUseFailure`, `StopFailure`. |
| `provisional/` | **PROVISIONAL, from docs, not observed** | Hand-written from https://code.claude.com/docs/en/hooks.md (read 2026-10-20). Kept for every event kind the observed folders do not cover: `StopFailure`, an untyped Agent call, Edit/Write/WebSearch/MCP/PowerShell tool shapes, a `SubagentStart` for a non-desk type, an unknown hook event. Cloud `PermissionRequest`/`Notification`/`PostToolUseFailure` are covered only by the PC shapes. |

Observed folders are exports of `scripts/spike-s2-export.mjs` (strings scrubbed, long strings cut, home paths replaced). Prompts and messages are therefore cut at about 200 characters with "…". The capture hooks that produced them live only on the throwaway branch `spike/s2-capture`, which is never merged.

## File format

Every fixture is a JSON wrapper:

```json
{
  "_provisional": "PROVISIONAL – from docs, not observed",
  "_source": "<doc URL + anchor>",
  "_notes": "optional",
  "payload": { "...": "the hook stdin JSON" }
}
```

Real captures exported by `scripts/spike-s2-export.mjs` use `"_observed"` instead of `"_provisional"`, so a test can always tell which kind it is reading.

The contract tests in `packages/core/test/contract.test.ts` read every fixture in these folders. For the observed folders they prove the code matches **real Claude Code output** (Windows CLI/Desktop 2.1.306; cloud 2026-10-25). `packages/emit/test/cloud-fixtures.test.ts` also runs every cloud fixture through emit with a cloud env (with and without `CLAUDE_EFFORT`). For `provisional/` they only prove it matches the documentation. Keep a provisional file until an observed one covers the same event kind.

## Rules

- Fixtures must contain no real secrets, prompts, file contents or personal paths. Secret-like test strings are built at runtime in tests, never stored here.
- Raw captures (`.spike/`) are never committed.
