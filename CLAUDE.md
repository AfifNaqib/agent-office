# Agent Office — Project Instructions

Single-user web app that visualises a Claude Code agent team as avatars in an isometric 2.5D pixel-art office ("Nothing-style night office"), with a Slack-like feed. Data comes from Claude Code hooks, on a PC and in cloud sessions. A PC bridge (Node) serves the office locally (v0); a Cloudflare Worker + Durable Object relay behind Cloudflare Access (v1) lets the owner watch from a phone anywhere; v2 adds control (start / stop / message / approve).

Stack: TypeScript (strict), npm workspaces, Vite + PixiJS, Hono, Cloudflare Workers + Durable Objects, zod, jose, Vitest, Playwright.

**The approved plan is `docs/build-plan.md`. The "PRODUCT OWNER DECISIONS" sections in it override the body.** Follow its CODER HANDOFF, implementation order and "MUST NOT change" list.

## The team

The owner (Product Owner) talks to one Claude Code session, **JEBON**, which leads a team of four subagents defined in `.claude/agents/`:

| Member | Role |
|---|---|
| **JEBON** (lead) | The main Claude Code session. Talks to the owner, runs the flow below, hands work to the subagents and reports back. |
| **architect** | Asks the blocking questions, writes the Build Plan and the Coder Handoff. |
| **coder** | Implements one task at a time; writes a Tester Handoff and an Implementation Report. |
| **tester** | Attacks the change; files bug reports and a SHIP / DO NOT SHIP verdict. |
| **manager** | Compares plan, code and test results; writes an Executive Summary, decisions required and release readiness. |

Flow: owner → JEBON → **architect** (questions → Build Plan → Coder Handoff) → owner approves → **coder** → **tester** → coder fixes → tester re-tests → **manager** → owner decides.

No agent silently changes another agent's responsibility. Major architecture or scope changes need the owner's approval.

## Non-negotiables

- **Never handle, store or forward Claude credentials, and never use the Agent SDK.** Only the unmodified `claude` CLI with the owner's own login, for their own use. No API key.
- **No secrets in the repo.** Tokens live in Worker secrets, cloud network secrets or the owner's user-profile config only. `npm run secret-scan` runs in CI and as a pre-commit hook.
- **Permissions never auto-approve.** Bridge runs with no decision in 240 s are denied; never `bypassPermissions`.

## Memory policy

- Write to MEMORY.md proactively: decisions, fixes applied, open items, environment quirks.
- When the owner corrects a mistake, log it in MEMORY.md so it isn't repeated.

@MEMORY.md
