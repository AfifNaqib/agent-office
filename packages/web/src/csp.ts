// Runs first (main.ts imports it before anything else): makes the page work under
// the relay CSP `script-src 'self'` (no 'unsafe-eval', R-1) without a single
// securitypolicyviolation report.
// - zod (used by core's schemas) probes `new Function('')` once to pick a faster
//   parser; under a strict CSP that probe is reported as a violation even though
//   zod catches the error. `jitless` skips the probe and the generated code.
// - Pixi 8 is handled by the `pixi.js/unsafe-eval` import in main.ts.
import { config } from 'zod';

config({ jitless: true });
