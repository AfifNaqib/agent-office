# Agent Office

A live isometric pixel-art office that shows a Claude Code agent team at work. The lead session and each subagent (architect, coder, tester, manager, ...) become avatars that move to their stations as they work, wait when a permission is pending, and report back when they are done. A Slack-like feed beside the office shows what each one is doing.

It watches sessions on your PC and in Claude Code cloud sessions, and you can follow along from your phone, anywhere, through a small Cloudflare relay behind Cloudflare Access.

## How it works

```
Claude Code hooks ──> emit (hook script) ──> PC bridge (127.0.0.1) ──> web office on the PC
   (PC + cloud)            │                       │
                           │ cloud sessions        │ outbound WebSocket
                           v                       v
                     Cloudflare relay (Worker + Durable Object, behind Access) ──> web office on the phone
```

1. **Hooks.** Claude Code runs `.claude/hooks/agent-office-emit.mjs` as an async command hook on session, prompt, tool, subagent, permission and notification events.
2. **emit** (`packages/emit`) reads the hook JSON, turns it into a small `OfficeEvent` with the shared core, scrubs it, and POSTs it: to the PC bridge on `127.0.0.1`, or, in a cloud session, to the relay's `/ingest`.
3. **Bridge** (`packages/bridge`, Node + Hono) listens on `127.0.0.1` only, keeps 7 days of events, serves the web office and a WebSocket feed, and can forward PC events to the relay.
4. **Relay** (`packages/relay`, Cloudflare Worker + one SQLite Durable Object) stores 7 days of cloud and forwarded events and serves the same web office behind Cloudflare Access.
5. **Web** (`packages/web`, Vite + PixiJS) draws the office, the lobby of sessions and the feed. It follows the newest session by default.

Raw tool input, tool output and transcripts never leave the machine: only short, scrubbed summaries do.

## Tech stack

TypeScript (strict), npm workspaces, zod, Vite + PixiJS, Node + Hono + `ws`, Cloudflare Workers + Durable Objects (SQLite) + Workers static assets + Cloudflare Access, `jose`, esbuild, Vitest, Playwright + axe.

| Package | What it is |
|---|---|
| `packages/core` | `OfficeEvent` schema, redaction, normalization, reducers (pure; runs in Node, Workers and browsers) |
| `packages/emit` | The hook script, built to one dependency-free file |
| `packages/bridge` | PC bridge on `127.0.0.1` |
| `packages/relay` | Cloudflare Worker + Durable Object relay |
| `packages/web` | The office UI |

## Security model

- **No credentials, no Agent SDK, no API key.** Agent Office only reads hook events. It never touches Claude credentials and uses only the unmodified `claude` CLI with your own login.
- **Scrubbing everywhere.** Prompts, summaries, names and ids are scrubbed for secrets (tokens, keys, passwords, cookies, URL userinfo, JWTs, private-key blocks, invisible-character tricks) in emit and again in the bridge and the relay. All scrub rules are linear-time and covered by an adversarial performance test.
- **Local bridge.** Binds `127.0.0.1` only, checks the `Host` header, needs a random local token (`~/.agent-office/local-token`) for events, history and the WebSocket.
- **Relay.** Cloud hooks authenticate with a Bearer token that the cloud environment's network secret adds; the bridge uses its own token. Every other path needs a Cloudflare Access login, and the Worker verifies the Access JWT itself (issuer, audience, expiry, allowed email). Strict CSP, no CORS, 7-day retention, rate limits.
- **Permissions never auto-approve.**
- **No secrets in the repo.** Tokens live in Worker secrets, the cloud network secret or your user profile. `npm run secret-scan` runs in CI and as a pre-commit hook.

## Quick start

Requirements: Node.js 22.13 or newer, npm, Claude Code.

**On your PC** (details: [docs/setup-pc.md](docs/setup-pc.md)):

```sh
npm ci
npm run build
npm run setup:pc -- --dry-run   # shows what would change
npm run setup:pc                # data folder, token, config, hook script, user hooks
npm run bridge                  # leave it running
```

Start a new Claude Code session, then open http://127.0.0.1:47821/.

Without a bridge, `npm run web` shows a scripted demo at http://127.0.0.1:5173.

**Relay for cloud sessions and your phone:** follow [docs/setup-cloudflare.md](docs/setup-cloudflare.md) (Cloudflare account, Access apps, secrets, deploy, cloud environment).

## Scripts

| Command | What it does |
|---|---|
| `npm ci` | Install exact locked dependencies (also points git at `.githooks/` for the pre-commit secret scan) |
| `npm run lint` | ESLint (type-aware for TypeScript) |
| `npm run typecheck` | `tsc --noEmit` in every workspace |
| `npm test` | Vitest, all workspaces and scripts |
| `npm run test:e2e` | Playwright + axe (see `docs/e2e.md`) |
| `npm run build` | Build every workspace |
| `npm run secret-scan` | Scan tracked and untracked (not ignored) files for obvious secrets |
| `npm run gen-token` | Print a new 32-byte random token (base64url) |
| `npm run setup:pc` | PC setup (`--dry-run`, `--uninstall`) |
| `npm run install-hooks` | Only the hooks merge (user settings, or `-- <repoPath>`) |
| `npm run bridge` | Build and start the PC bridge |
| `npm run web` | Web office dev server (demo mode) |
| `npm run secrets:check` | Check the relay Worker has its required secrets (names only) |
| `npm run deploy:relay` | Deploy `packages/relay` (refuses on a dirty tree or a failed secrets check) |
| `npm run relay:wrangler -- <args>` | The repo's wrangler, run in `packages/relay` |

## Status

- v0 (watch sessions on the PC) and v1 (cloud sessions + phone through the relay) are built.
- v2 (start / stop / message / approve from the office) is planned in `docs/build-plan.md`.

## Built with an AI agent team

This project was planned, built, tested and reviewed by a Claude Code agent team, with a human owner making every decision:

| Member | Role |
|---|---|
| **JEBON** (lead) | The main Claude Code session: talks to the owner and runs the flow |
| **architect** | Questions, Build Plan, Coder Handoff |
| **coder** | One task at a time, Tester Handoff, Implementation Report |
| **tester** | Bug reports, SHIP / DO NOT SHIP |
| **manager** | Executive Summary, decisions required, release readiness |

The team's instructions are in [CLAUDE.md](CLAUDE.md) and [.claude/agents/](.claude/agents/). The whole plan, with every amendment, is in [docs/build-plan.md](docs/build-plan.md), and the spikes that answered its open questions are in [docs/spikes/](docs/spikes/). This repo also runs Agent Office on itself: `.claude/settings.json` sends its own sessions to the office.

## Disclaimer

Agent Office is an independent project. It is not affiliated with, endorsed by or sponsored by Anthropic or Cloudflare. "Claude" and "Claude Code" are trademarks of Anthropic; "Cloudflare" is a trademark of Cloudflare, Inc.

## License

[MIT](LICENSE)
