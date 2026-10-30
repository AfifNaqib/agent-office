# Hook configuration templates

| File | Goes to | Notes |
|---|---|---|
| `repo-settings.json` | `<repo>/.claude/settings.json` (merged, never replacing other keys), plus the built script at `<repo>/.claude/hooks/agent-office-emit.mjs` | `npm run install-hooks -- <repoPath>` (V0) does both. |
| `user-settings.json` | `~/.claude/settings.json` on the PC | Replace `__AGENT_OFFICE_EMIT_PATH__` with the absolute path of `%USERPROFILE%\.agent-office\hooks\agent-office-emit.mjs`. `npm run setup:pc` (see `docs/setup-pc.md`) copies the script there, creates the token and `config.json`, and merges these hooks into `~/.claude/settings.json` with the path filled in (other keys and hooks kept, one-time backup, re-running changes nothing). `npm run install-hooks` does the hooks part only; both take `--dry-run`, `--uninstall` and `--settings <file>`. Our hooks are recognised as `node` + one arg ending in `agent-office-emit.mjs`. |
| `spike-s2-capture.settings.json` | nowhere | Capture-only hooks used by spike S2 on a throwaway branch. Never installed. |

The script is `packages/emit` (`npm run build -w @agent-office/emit` -> `packages/emit/dist/agent-office-emit.mjs`, one file, no runtime dependencies).

## Hook form

All commands use the **exec form**: `"command": "node"` plus `"args": [...]`. It was observed to work on Windows (Claude Code 2.1.306, CLI and Desktop app; S2). The **shell form** (`"command": "node \"$CLAUDE_PROJECT_DIR/...\""`) also worked on that PC (both forms ran, with `CLAUDE_PROJECT_DIR` set), so it is a fallback if exec form ever stops working. `${CLAUDE_PROJECT_DIR}` expands inside `args`. Expansion of other variables inside `args` was not observed, which is why the user template uses a placeholder for the absolute path.

Every hook is `async: true`; the tool events and `PermissionRequest` use matcher `"*"`. There is no `onFailure` setting.

## Behaviour (FR-001 to FR-004)

- Destination: `CLAUDE_CODE_REMOTE_SESSION_ID` set -> cloud relay `$AGENT_OFFICE_RELAY_URL/ingest`. Otherwise -> `http://127.0.0.1:47821/hooks/event` with header `X-Agent-Office-Local: <token>`, the token read from `~/.agent-office/local-token`. No token or no relay URL -> nothing is sent.
- Optional overrides: `AGENT_OFFICE_HOME` (folder with `local-token` and `config.json`), `AGENT_OFFICE_BRIDGE_PORT` (port only; the host is always 127.0.0.1). Port order, same as the bridge: `AGENT_OFFICE_BRIDGE_PORT`, then `port` in `<AGENT_OFFICE_HOME>/config.json` (integer 1024 to 65535, regular file under 64 KB, anything else ignored), then 47821. `AGENT_OFFICE_RUN_ID` marks a bridge run.
- Always exits 0, prints nothing, 3 s send timeout, ignores malformed or unknown input. The body is a normalized, scrubbed `OfficeEvent`; raw `tool_input`, `tool_response`, transcripts and the full `cwd` never leave.
- The repo copy wins: a copy that finds `$CLAUDE_PROJECT_DIR/.claude/hooks/agent-office-emit.mjs` and is not that file exits without sending.

## Cloud auth is PROVISIONAL (until spike S1)

The script carries no token. The plan's primary design is that the cloud environment's network secret adds `Authorization: Bearer <INGEST_TOKEN>` for the relay host outside the script. That is unverified until S1. If S1 shows it does not work, the documented fallback (an env var token) is a change to `cloudDestination` in `packages/emit/src/destination.ts` only. Tests use a mock server.
