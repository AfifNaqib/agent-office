# Cloudflare relay setup (PowerShell)

One-time. About 20 minutes. Puts the relay online at `https://<relay>.<your-subdomain>.workers.dev`, so cloud sessions can send their events and your phone can watch.

Placeholders: `<relay>` is the Worker name (`agent-office`, from `packages/relay/wrangler.jsonc`), `<your-subdomain>` is your account's workers.dev subdomain, `<team>` is your Zero Trust team name, and `you@example.com` stands for your Access login email (also set it in `ACCESS_ALLOWED_EMAILS` in `packages/relay/wrangler.jsonc`).

Run every command in PowerShell, inside the repo folder (`C:\path\to\agent-office`).

**Never paste a token into a chat, an issue or a file in the repo.** Tokens only go into `wrangler secret put` and the claude.ai network secret.

## 0. Before you start

1. Node must be 22.13 or newer (same as the repo's `engines`; wrangler needs 22+).
   ```powershell
   node --version
   ```
   Older than `v22.13`? Install the current LTS from https://nodejs.org, then open a new PowerShell window.
2. Get the code and packages.
   ```powershell
   git pull
   npm ci
   ```
3. Check you are logged in to Cloudflare (you did `wrangler login` already).
   ```powershell
   npm run relay:wrangler -- whoami
   ```
   Expect: your email and the account. Not logged in? `npm run relay:wrangler -- login`.

`npm` or `node` not found? See "PATH is locked" at the end.

## 1. Make the ingest token and store it

The ingest token lets cloud sessions write events. The first `secret put` also creates the Worker (answer **y** if asked).

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$t = node scripts\gen-token.mjs
if ($t -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'bad token' }
$t | npm run relay:wrangler -- secret put INGEST_TOKEN
```

Expect: `Success! Uploaded secret INGEST_TOKEN`. `bad token` instead? Nothing was stored: run the four lines again.

What the lines do:
- Line 1 makes the pipe send plain UTF-8 **without a BOM** for this window. Windows PowerShell 5.1 with `$OutputEncoding` set to UTF8 (some profiles do that) puts 3 hidden bytes (a BOM) in front of piped text, so the stored token would not match the one in step 6 and every cloud event would get 401. This line rules that out.
- Line 3 stops before storing anything if the token is not exactly 43 letters, digits, `-` or `_`.

Keep this PowerShell window open: you need `$t` once more in step 6. Do not print it in a chat.

### 1b. Make the bridge token and store it (V1-04)

The bridge token lets the PC bridge send your PC sessions to the relay (so the phone sees them too). Same window as step 1:

```powershell
$b = node scripts\gen-token.mjs
if ($b -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'bad token' }
$b | npm run relay:wrangler -- secret put BRIDGE_TOKEN
```

Expect: `Success! Uploaded secret BRIDGE_TOKEN`. Keep the window open: step 8 writes `$b` into the PC config. It is a different token from `$t`; never use one for the other.

## 2. Lock it with Cloudflare Access

Same steps as spike S5 (`docs/spikes/S5.md`), now for the real relay. The relay also checks the Access login itself (V1-02), so it only works once steps 2 and 3 are both done.

1. Cloudflare dashboard → **Workers & Pages** → **agent-office** → **Settings** → **Domains & Routes** → `workers.dev` → **Enable Cloudflare Access**. Scope: **All traffic** (main URL and previews).
   This creates the Access app "agent-office - Cloudflare Workers" with the policy "Cloudflare account members" (that is you).

   No `workers.dev` row or no **Enable Cloudflare Access** button (the Worker was never deployed)? Run `npm run relay:wrangler -- deploy` once, then come back. That is safe: without the step 3 settings the relay refuses everything except `/ingest` (it answers 503, it never opens up).

   Then make that app follow the plan (D-03): Zero Trust → **Access** → **Applications** → **agent-office - Cloudflare Workers** → **Edit**.
   - **Policies** → **Add a policy**: name `po-email`, action **Allow**, include **Emails** = `you@example.com`. Keep "Cloudflare account members" (it is also you).
   - **Session duration**: **24 hours** (on the app, and on the new policy if it has its own setting).
   - Save.
2. Zero Trust → **Access** → **Applications** → **Create new application** → **Self-hosted**.
   - Name: `agent-office-ingest`
   - Public hostnames (two rows): `<relay>.<your-subdomain>.workers.dev` with path `ingest`, and `<relay>.<your-subdomain>.workers.dev` with path `bridge`
   - Policy: name `bypass`, action **Bypass**, include **Everyone**
   - Session: 24 hours
   - Save.

   Why: cloud sessions and the PC bridge cannot log in. The relay checks its own token on these two paths.

## 3. Store the two Access settings

The relay checks every login itself: the login must come from your team (`<team>.cloudflareaccess.com`), be made for this app (its AUD tag), and be for `you@example.com`. Neither value is secret, but they are stored with `secret put` like the token.

1. Copy the AUD tag: Zero Trust → **Access** → **Applications** → **agent-office - Cloudflare Workers** → **Configure** (or Edit) → **Overview** → **Application Audience (AUD) Tag** → copy. It is a long run of letters and digits (usually 64). Take it from **this** app, not from `agent-office-ingest` or an `<spike>` app.
2. Store both (same window as step 1 is fine):
   ```powershell
   $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
   '<team>.cloudflareaccess.com' | npm run relay:wrangler -- secret put ACCESS_TEAM_DOMAIN
   $aud = (Read-Host 'Paste the AUD tag').Trim()
   if ($aud -notmatch '^[A-Za-z0-9_-]{16,256}$') { throw 'bad AUD tag' }
   $aud | npm run relay:wrangler -- secret put ACCESS_AUD
   ```
   Expect: `Success! Uploaded secret ACCESS_TEAM_DOMAIN`, then (after you paste) `Success! Uploaded secret ACCESS_AUD`. `bad AUD tag` instead? Nothing was stored for it: copy the tag again and run the last three lines again.

The allowed email (`you@example.com`) is not a secret: it is in `packages/relay/wrangler.jsonc` (`ACCESS_ALLOWED_EMAILS`) and goes out with every deploy.

Re-made the Access app (or deleted and enabled Access again)? It gets a new AUD tag: repeat this step (works at once, no new deploy needed).

## 4. Check the secrets

```powershell
npm run secrets:check
```

Expect:
```
ok      INGEST_TOKEN
ok      ACCESS_TEAM_DOMAIN
ok      ACCESS_AUD
ok      BRIDGE_TOKEN
secrets: ok
```
Only names are shown, never values. `MISSING ACCESS_...`: do step 3 again. `MISSING BRIDGE_TOKEN`: do step 1b (deploy refuses without it since V1-04).

## 5. Deploy and check

```powershell
npm run deploy:relay
```

Expect: `secrets: ok`, then `building the office web app (packages/web) ...` with the Vite output, then wrangler output (it lists `env.ASSETS` and uploads the web files) ending with the URL `https://<relay>.<your-subdomain>.workers.dev`, then `deployed.`

The first deploy after step 1 may ask that the Worker was "last updated via the script API" (that was the `secret put`) and whether to continue: answer **y**.

It refuses (and changes nothing) when:
- `working tree is dirty`: you have local changes. Run `git status`, then commit or undo them. (Untracked files outside `packages\relay`, `packages\core` and `packages\web`, like `graphify-out`, are fine.)
- `assume-unchanged or skip-worktree`: git was told to hide changes to the listed files, so `git status` cannot show them. Run the `git update-index --no-assume-unchanged --no-skip-worktree <file>` line it prints for each file, then check `git status` again.
- `.wrangler/deploy/config.json exists`: a leftover wrangler redirect file would make wrangler deploy a different config. Delete `packages\relay\.wrangler\deploy\config.json` and run it again.
- `secrets check failed`: do step 1 (INGEST_TOKEN), 1b (BRIDGE_TOKEN) or step 3 (ACCESS_...) again.
- `web build failed`: the office web app did not build. Run `npm ci`, then deploy again; if it still fails, send the coder the Vite error printed above it.

It only **warns** (and still deploys) with `this commit is not on origin/main`: you are on another branch or behind. Usually you want `git pull`, then `npm ci`, then deploy again. The script does not fetch, so it compares with your last `git pull`.

Check it (PowerShell uses `curl.exe`, not `curl`):
```powershell
curl.exe -s -o NUL -w "%{http_code}`n" https://<relay>.<your-subdomain>.workers.dev/api/health
curl.exe -s -o NUL -w "%{http_code}`n" https://<relay>.<your-subdomain>.workers.dev/ingestx
curl.exe -s -o NUL -w "%{http_code}`n" -X POST https://<relay>.<your-subdomain>.workers.dev/ingest
```
Expect: `302`, `302` (Access login), then `401` (the relay itself: no token sent). `503` on the last one means INGEST_TOKEN is missing: do step 1 again.

Then in a browser open `https://<relay>.<your-subdomain>.workers.dev/api/health`: you get the Access login, then `{"ok":true,"bridgeOnline":false,"events7d":<number>}` (`bridgeOnline` turns true once the PC bridge is connected, step 8). That proves the relay accepts your login (step 3 values are right). Instead you see:
- `{"error":{"code":"not_configured",...}}`: ACCESS_TEAM_DOMAIN or ACCESS_AUD is missing or malformed. Do step 3 again.
- `{"error":{"code":"unauthorized",...}}`: the AUD tag is from the wrong app, or the team domain is wrong. Do step 3 again with the tag from "agent-office - Cloudflare Workers".
- `{"error":{"code":"unavailable",...}}` (503, tail log `"kind":"certs"`): the relay could not fetch the Access signing certs from Cloudflare (a Cloudflare-side or network problem, not your settings). Wait a minute and reload; the relay retries at most every 30 s. Do NOT redo step 3.
- `{"error":{"code":"forbidden",...}}`: you logged in with another email. Log out (open `https://<team>.cloudflareaccess.com/cdn-cgi/access/logout`) and log in with `you@example.com`.

To see why the relay refused a login, run `npm run relay:wrangler -- tail` while you reload the page: each refusal prints one line like `{"route":"access","status":401,"kind":"invalid"}` (never the login token or your email).

None of this proves the INGEST_TOKEN is the RIGHT one (no BOM, no typo). Only the end-to-end check in step 6 (D-04) does: a real cloud session's events arriving.

### 5b. Live socket check (after deploying V1-03, once)

This proves Access passes your login on to the relay for a WebSocket too (risk R-3; local tests cannot check it).

1. In the browser where `/api/health` worked, stay on that tab and press **F12** → **Console**.
2. Paste this and press Enter (Chrome may ask you to type `allow pasting` first):
   ```js
   const ws = new WebSocket('wss://<relay>.<your-subdomain>.workers.dev/ws/ui');
   ws.onmessage = (m) => console.log('got', m.data);
   ws.onclose = (e) => console.log('closed', e.code);
   ```
3. Expect within a second: `got {"type":"hello","boot":"…","lastSeq":…}`. **PASS.**
4. Optional: do anything in a cloud session (D-04). Each event shows as `got {"type":"event",…}` within about a second.
5. Close it: `ws.close()` (prints `closed 1000` or `closed 1005`).

Instead you see `closed 1006` and no `got`: run `npm run relay:wrangler -- tail` and paste the snippet again.
- Tail shows `{"route":"access","status":401,"kind":"missing"}`: Access did NOT add the login to the socket request (R-3 FAIL). Stop and tell the coder; nothing is exposed (the relay refused it).
- Tail shows `"status":403,"kind":"origin"`: the snippet ran on another site's tab. Use the `/api/health` tab.
- Nothing in the tail: Access itself refused it (login expired). Reload `/api/health`, log in, try again.

### 5c. Open the office on your phone (after deploying V1-05)

The relay now serves the office web app itself, behind the same Access login. Do 5b first if you have not yet (after the same deploy is fine).

1. On the phone, open `https://<relay>.<your-subdomain>.workers.dev` (bookmark it, or add it to the home screen).
2. Access asks for your email: enter `you@example.com`, then the one-time code from the mail.
3. Expect the night office and, at the top of the panel, `● LIVE · relay` followed by the newest cloud session (`<repo> · Cloud · live`), or `● LIVE · relay  no sessions yet` before any cloud session ran. **PASS.**
4. Optional: start or prompt a cloud session (D-04). Within a few seconds it shows in the lobby with the Cloud badge and its lines appear in the feed.

What the status line means:
- `○ connecting` for more than ~20 s, or `○ relay offline, retrying`: no connection or the relay is down. It retries by itself (every 4 s at most).
- `○ login expired` with a red **Log in again** link (after the 24 h Access session): tap it; Access asks for the code again.
- `○ paused: opened in a newer tab` with **Reconnect**: more than 16 office tabs were open, so this old one gave its place to a newer one. Tap Reconnect, or close old tabs.
- The page shows `{"error":{"code":"ui_not_deployed",...}}`: the web build was not uploaded. Run `npm run deploy:relay` again (it builds it first).
- Any other `{"error":...}` page: see the list under step 5 (same login checks as `/api/health`).

The PC office (`npm run bridge`, http://127.0.0.1:47821) keeps working as before; it shows `● LIVE` without `· relay`.

After step 8 the phone's status line also says whether the PC bridge is connected: `● LIVE · relay · PC on` or `· PC off`.

Run `npm run deploy:relay` again after every `git pull` that changes the relay or the web app.

**Deployed and locked with Access before V1-02 (older version of this guide)?** Only do step 3 (the two Access settings), then step 4, then `git pull`, `npm ci` and step 5.

## 6. Cloud environment (D-04, short)

claude.ai/code → your environment → **Edit**:
- Allowed domain: `<relay>.<your-subdomain>.workers.dev`
- Network secret: host `<relay>.<your-subdomain>.workers.dev`, header `Authorization`, value `Bearer ` followed by the token. Put the token on your clipboard from the step 1 window:
  ```powershell
  Set-Clipboard -Value $t
  ```
  Paste it after `Bearer ` (one space). Then clear it:
  ```powershell
  Set-Clipboard -Value " "
  Remove-Variable t
  ```
  Windows clipboard history keeps old copies: press **Win+V** and delete the token entry (… → Delete). Safer: before `Set-Clipboard`, turn off Settings → System → Clipboard → **Clipboard history** and **Sync across devices**, and turn them back on after.
- Environment variable (not secret): `AGENT_OFFICE_RELAY_URL=https://<relay>.<your-subdomain>.workers.dev`

Full cloud guide comes with V1-06b (`docs/setup-cloud-env.md`).

Lost the token (window closed)? Make a new one: repeat step 1, then update the network secret. The old one stops working.

## 7. Remove the spike Worker (only if you ran spikes S1/S5)

`<spike>` is the name of the throwaway spike Worker.

After step 6 works:
1. Cloud environment → Edit: remove the `<spike>.<your-subdomain>.workers.dev` network secret and allowed domain.
2. Zero Trust → Access → Applications: delete `<spike> - Cloudflare Workers` and `<spike>-ingest`.
3. Delete the spike Worker:
   ```powershell
   npm run relay:wrangler -- delete <spike>
   ```
   Wrangler asks to confirm. **Check the question says `<spike>`**, then answer y.

## 8. Send PC sessions to the relay (D-05, V1-04)

Needs step 1b done and the relay deployed with V1-04 (step 5). The bridge then sends every PC event to the relay too, so the phone shows PC sessions (PC badge) next to cloud ones. Without these settings the bridge stays local only.

**Run only one bridge with this token** (one window, one PC). Two bridges with the same token keep replacing each other about every 60 s and the phone's PC status flickers.

1. Same window as step 1b (`$b` is still set). Write the relay address and the bridge token into the bridge config (plain UTF-8; a BOM is ignored since the L-3 fix; other keys like `port` and `claudePath` stay):
   ```powershell
   $p = "$env:USERPROFILE\.agent-office\config.json"
   $c = if (Test-Path $p) { Get-Content $p -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
   $c | Add-Member -Force -NotePropertyName relayUrl -NotePropertyValue 'https://<relay>.<your-subdomain>.workers.dev'
   $c | Add-Member -Force -NotePropertyName bridgeToken -NotePropertyValue $b
   [IO.File]::WriteAllText($p, ($c | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
   Remove-Variable b
   ```
   No output means it worked. `config.json` lives in your user profile (only your Windows account can read it); never copy it into a repo or a chat.
2. Restart the bridge: in its window press **Ctrl+C**, then
   ```powershell
   npm.cmd run bridge
   ```
   Expect: `info relay forwarding on: <relay>.<your-subdomain>.workers.dev`, `info listening on ...`, then `info relay connected (0 buffered)`.
3. Check: `Invoke-RestMethod http://127.0.0.1:47821/api/health` shows `relay : connected`. On the phone (step 5c) the status line shows `· PC on`; send a prompt in a PC Claude session and it appears in the phone's lobby within a few seconds.

What the bridge window can say:
- `warn relay offline (HTTP 401 (BRIDGE_TOKEN in config.json does not match the relay secret) ...`: the token in `config.json` is not the stored secret. Do step 1b again, then step 8.1 with the new `$b`, and restart.
- `warn relay offline (HTTP 503 (the relay has no BRIDGE_TOKEN secret yet) ...`: do step 1b.
- `warn relay offline (HTTP 302 (Cloudflare Access did not let it through ...`: the bypass app `agent-office-ingest` must list the path `bridge` too (step 2).
- `warn relay offline (...)` with anything else (no internet, relay down): it retries by itself (every 30 s at most) and keeps up to 1000 events to send when it is back. Events still show in the PC office meanwhile. If the bridge itself is restarted while offline, the waiting events are not sent (they stay in the PC history).
- `warn relay offline (another bridge took over ...`: a second bridge (another window or PC) uses the same token. Only one bridge can be connected; close the other one.
- `warn relay offline (close 1008 ...`: the relay refused too many bad messages in one minute (a bug, not your setup). It reconnects by itself; tell JEBON if it repeats.
- `bridge: config.json: set both relayUrl and bridgeToken, or neither`, or `config.json is invalid at: relayUrl` / `bridgeToken`: fix the file (step 8.1 again).

To turn it off: remove `relayUrl` and `bridgeToken` from `config.json` and restart the bridge.

Rotate the bridge token: step 1b (new `$b`), step 8.1, restart the bridge. The old token stops working at once.

## Undo (remove the relay)

```powershell
npm run relay:wrangler -- delete agent-office
```
Check the question says `agent-office`, then answer y. This deletes the Worker, its secrets and all stored events. Also delete the two Access apps (`agent-office - Cloudflare Workers`, `agent-office-ingest`) and the cloud network secret. Steps 1 to 5 bring it back.

## PATH is locked

Same trick as `docs/setup-pc.md`: use full paths.

```powershell
$node = "C:\Program Files\nodejs"
& "$node\npm.cmd" run secrets:check
& "$node\npm.cmd" run deploy:relay
```

If `npm.cmd run` cannot find node, call the scripts with node directly:

| Instead of | Run |
|---|---|
| `npm run relay:wrangler -- <args>` | `& "$node\node.exe" scripts\relay-wrangler.mjs <args>` |
| `npm run secrets:check` | `& "$node\node.exe" scripts\secrets-check.mjs` |
| `npm run deploy:relay` | `& "$node\node.exe" scripts\deploy-relay.mjs` |
| `node scripts\gen-token.mjs` | `& "$node\node.exe" scripts\gen-token.mjs` |
| `npm.cmd run bridge` | `& "$node\node.exe" packages\bridge\dist\agent-office-bridge.mjs` (after `npm run build`) |

Step 1 with full paths:
```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$t = & "$node\node.exe" scripts\gen-token.mjs
if ($t -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'bad token' }
$t | & "$node\node.exe" scripts\relay-wrangler.mjs secret put INGEST_TOKEN
```

Step 1b with full paths:
```powershell
$b = & "$node\node.exe" scripts\gen-token.mjs
if ($b -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'bad token' }
$b | & "$node\node.exe" scripts\relay-wrangler.mjs secret put BRIDGE_TOKEN
```

`deploy:relay` also needs `git` (you already use it for `git pull`).

## Not working?

| Symptom | Try |
|---|---|
| `wrangler secret list` failed, `not logged in` | `npm run relay:wrangler -- login` |
| `Worker "agent-office" not found` | Do step 1 first (it creates the Worker). |
| `Node vXX is too old` | Install Node 22.13+ (step 0). |
| `wrangler not found` | `npm ci` |
| Office page shows `ui_not_deployed` | `npm run deploy:relay` again (step 5c). |
| `/api/health` gives 404 in the browser | Wait a minute after the first deploy (workers.dev takes a moment), then reload. |
| `POST /ingest` gives 302 | The bypass app is missing or the path is wrong (step 2.2). |
| `/api/health` in the browser shows `not_configured`, `unauthorized`, `forbidden` or `unavailable` | See the list under step 5 (`unavailable` = Cloudflare certs problem: wait and retry). |
| `npm run secrets:check` shows `MISSING ACCESS_TEAM_DOMAIN` or `MISSING ACCESS_AUD` | Do step 3. |
| `POST /ingest` gives 503 | INGEST_TOKEN is not set: do step 1 (works at once, no new deploy needed). |
