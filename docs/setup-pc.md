# PC setup (PowerShell)

One-time. Takes about 2 minutes. Run every command in PowerShell, inside the repo folder.

## Install

1. Get the code.
   ```powershell
   cd C:\path\to\agent-office
   git pull
   ```
2. Install packages and build.
   ```powershell
   npm ci
   npm run build
   ```
   Expect: no red errors, `found 0 vulnerabilities`.
3. See what setup would do (writes nothing).
   ```powershell
   npm run setup:pc -- --dry-run
   ```
   Expect: a list ending in `dry run: nothing was written`, with 12 `+` hook lines.
   Ran an older `setup:pc` before? Then you see 12 `-` and 12 `+` lines instead. That is fine: the old hook path is replaced in place. The old script copy `%USERPROFILE%\.agent-office\agent-office-emit.mjs` is no longer used; delete it if you like.
4. Run setup.
   ```powershell
   npm run setup:pc
   ```
   Expect: `backup of the original: ...settings.json.agent-office.<time>.bak` (only if you already had a settings file), then `hooks installed`, then `next: npm run bridge`.
   If you see `warning: claude.exe not found at ...`, see "claudePath" below.
   If it fails with `EPERM` while copying the script: close all Claude sessions, run it again.
5. Start the bridge. Leave this window open.
   ```powershell
   npm run bridge
   ```
   Expect: `info listening on http://127.0.0.1:47821 ...`.
6. Start a **new** Claude Code session (Claude Code may read hooks only when a session starts). Send any prompt.
7. Check it works.
   - Bridge window prints lines like `event session.start ...` and `event tool.start ...`.
   - Open http://127.0.0.1:47821/ in the browser: the office shows your session.
   - Or: `Invoke-RestMethod http://127.0.0.1:47821/api/health` shows `events` going up.

Setup is safe to run again any time (after `git pull`, after moving the repo). Second run says `hooks: already up to date`.

## What setup touches

| Where | What |
|---|---|
| `%USERPROFILE%\.agent-office\local-token` | secret token for the bridge. Never copied anywhere else. Never printed. |
| `%USERPROFILE%\.agent-office\config.json` | `port`, `claudePath`. Other keys you add are kept (e.g. `relayUrl`, `bridgeToken` for the relay, see below). |
| `%USERPROFILE%\.agent-office\hooks\agent-office-emit.mjs` | the hook script (a copy, so the repo can move). |
| `%USERPROFILE%\.claude\settings.json` | our 12 hooks added. Every other key and hook stays. First change makes one backup: `settings.json.agent-office.<time>.bak`. |

Set `AGENT_OFFICE_HOME` first if you want the data folder somewhere else. Use a plain path: no `$`, `%`, backtick or `"`. Setup refuses those.

If `settings.json` is not valid JSON, setup stops and changes nothing. Fix the file, run again.

## claudePath

Only needed later (control features). Setup fills it in when `claude.exe` is at `%USERPROFILE%\.local\bin\claude.exe`. Otherwise it warns and leaves it out. To set it by hand, edit `%USERPROFILE%\.agent-office\config.json`:

```json
{ "port": 47821, "claudePath": "C:\\Users\\<you>\\.local\\bin\\claude.exe" }
```

Find the real path with `(Get-Command claude).Source`, or look in that folder. Use double backslashes.

## Different port

Put `"port": 50123` (1024 to 65535) in `config.json`. The bridge and the hook script both read it. Set it in `config.json` only. An environment variable set just in the bridge window is NOT seen by Claude's hooks, so events would go to the wrong port. (`AGENT_OFFICE_BRIDGE_PORT` still wins over the file where it is set, but hooks never get it from your PowerShell window.)

## Phone sees PC sessions (relay, V1-04)

Off by default. Once the relay is online (`docs/setup-cloudflare.md`), the bridge can send your PC events to it, so the phone office shows PC sessions too. Steps: `docs/setup-cloudflare.md` step 1b (make the bridge token, `secret put BRIDGE_TOKEN`) and step 8 (write `relayUrl` + `bridgeToken` into `config.json`, restart with `npm.cmd run bridge`). Only the bridge token goes to the relay; the `local-token` never leaves the PC.

## Uninstall

```powershell
npm run setup:pc -- --uninstall
```

Expect: `hooks removed`. Only our hooks go. Your other settings and hooks stay. The token, `config.json` and the script copy stay too; delete `%USERPROFILE%\.agent-office` by hand if you want them gone. `npm run setup:pc -- --uninstall --dry-run` previews it.

Backups of your original settings are never deleted: `%USERPROFILE%\.claude\settings.json.agent-office.*.bak`.

## PATH is locked

`npm` or `node` not found in PowerShell? Use full paths. Check where node is:

```powershell
Get-Command node
```

Try `npm.cmd` first (below). If `npm.cmd run` says it cannot find node, use the last fallback (node with its full path).

For the usual install location:

```powershell
$node = "C:\Program Files\nodejs"
& "$node\npm.cmd" ci
& "$node\npm.cmd" run build
& "$node\npm.cmd" run setup:pc
& "$node\node.exe" packages\bridge\dist\agent-office-bridge.mjs
```

Fallback if `npm.cmd run` cannot find node (run setup with node directly):

```powershell
& "$node\node.exe" scripts\setup-pc.mjs
```

The `packages\bridge\dist` line is the bridge without npm (after `npm run build`). The hooks themselves call plain `node`; this was seen working on this PC.

## Not working?

| Symptom | Try |
|---|---|
| Bridge window shows nothing when Claude works | Start a new Claude Code session. Check `settings.json` has `agent-office-emit.mjs` lines. |
| `port 47821 is already in use` | Another bridge is running, or set another `port` in `config.json`, then run the bridge again. |
| `local-token does not hold a valid token` | Delete `%USERPROFILE%\.agent-office\local-token`, run setup again. |
| Events stop after you add a repo-level copy of the hook | By design: a repo copy at `.claude\hooks\agent-office-emit.mjs` wins over the user copy. |
