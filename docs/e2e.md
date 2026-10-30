# Browser smoke tests (Playwright + axe)

`packages/web/e2e` drives the built UI, served by the real built bridge (`packages/bridge/dist`), in headless Chromium at 1440x900 (project `desktop`) and 390x844 @3x with touch (project `phone`). The observed team run (`fixtures/sessions/team-run.jsonl`) is posted to the bridge over `POST /hooks/event`. `relay.spec.ts` serves the same build from the relay Worker under `wrangler dev` instead (V1-05, see the table).

They are **not** part of `npm test` (they need a browser and a full build).

## Run

```
npx playwright install chromium     # once
npm run test:e2e                    # builds everything, then runs both projects
```

Where Chromium is already installed (the cloud sandbox), point at it instead of downloading one:

```
AGENT_OFFICE_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npm run test:e2e
```

Output goes to `test-results/` (git-ignored); `test-results/fps.json` gets one line per fps run.

## What is checked

| Spec | Checks |
|---|---|
| `office.spec.ts` | no page errors or console errors, no horizontal scroll, a live avatar state (`window.__office.state()` via `?debug`), a pending permission card, axe: 0 violations, W-01: keyboard focus stays on a lobby button for 6 s of ticking, Enter pins, Space on "Follow newest" unpins |
| `layout.spec.ts` | 13 avatars (JEBON, 4 desk agents at the server rack, 8 visitors): no tag overlaps, tags on screen, 8 distinct visitor seats; visitors that leave are freed; phone: room fills the width, tag text >= 10 px; HiDPI 1x / 2x / 3x: resolution = device ratio capped at 2 (and by the pixel budget), canvas size = CSS size x resolution, room fits (also at 800x600); tags stay inside the view (x and y) |
| `relay.spec.ts` (V1-05) | the same built UI served by the relay Worker (`wrangler dev`, local workerd, the TEST ONLY entry `packages/relay/test/workerd/`) as Workers static assets behind the Access guard. A local "Access stand-in" proxy (`e2e/relay-harness.ts`) adds a test-signed `Cf-Access-Jwt-Assertion` to every request incl. the WebSocket upgrade (Playwright's extra headers do not reach upgrades). Checks: replayed cloud events (team run via `POST /ingest`) and a live one in the feed, `LIVE · relay` + Cloud in the status, no page/console errors and no `securitypolicyviolation`, no horizontal scroll (also 390x844); without the JWT `/` and the bundle are 401; login expiry (desktop only, ~35 s): JWT exp passes, the next event closes the socket 4401, the login probe gets 401, "Log in again" shows |
| `fps.spec.ts` | six avatars walking at once (V0-04 AC), frame rate counted with `requestAnimationFrame`, floor 6 fps |

## Frame rate: what the numbers mean

The V0-04 target is 30 fps with 6 walking avatars on a normal machine. Headless Chromium in the sandbox renders with **software GL (SwiftShader)**, no real GPU, so the numbers below are indicative only. The test floor (6 fps) is far below the target on purpose: it catches a collapse, it does not prove 30 fps on a real GPU. The phone project also throttles the CPU 4x (CDP `Emulation.setCPUThrottlingRate`), which is a rough stand-in for a mid-range phone, not a measurement of one.

Run on 2026-10-25, sandbox, Chromium 141 (software GL), 6 avatars walking at once (`maxWalkingAtOnce` = 6), after the HiDPI change (canvas drawn at the device pixel ratio). The PO later capped the resolution at 2x (2026-10-25), see the note below the table:

| Project | Viewport | DPR | CPU throttle | fps (2 runs) |
|---|---|---|---|---|
| desktop | 1440x900 | 1 | none | 28.4, 26.8 |
| phone (measured at 3x, before the 2x cap) | 390x844 | 3 | 4x | 11.6, 11.3 |

Before HiDPI the canvas was always drawn at 1x: desktop 26.8, phone 40.0. The phone drop is the 9x pixel count of a 3x canvas filled by a CPU rasteriser plus a 4x throttle; a phone GPU fills those pixels far faster, so treat 11 fps as a worst case, not a result for real hardware. **Not verified:** a real GPU, a real phone, Windows. 30 fps on the PO's machines still has to be checked by eye (`?fps` shows the frame rate in the corner).

**2x cap (2026-10-25, PO decision):** the renderer resolution is now `min(devicePixelRatio, 2)`, scaled down continuously (never below 1) when the backing store would exceed 8.5M pixels, so a 2560x1440 canvas at DPR 2 or 3 gets about 1.5x. The phone figure above (11 fps) was measured at 3x (9x the pixels of 1x); at the 2x cap a phone canvas has 4/9 of those pixels, so it is faster: one run after the cap measured 20.6 fps (phone, 4x throttle, software GL), single run only.
