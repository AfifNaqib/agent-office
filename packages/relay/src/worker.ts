// Worker entry: binds the Hono app to the single OfficeHub instance.
// The entry module may only export handlers and classes (an exported const broke workerd).
import { createApp } from './app.js';
import { OfficeHub } from './hub.js';
import { hubClient } from './hubClient.js';
import type { RelayBindings } from './types.js';

export { OfficeHub };

interface WorkerEnv extends RelayBindings {
  readonly HUB: DurableObjectNamespace<OfficeHub>;
}

const app = createApp<WorkerEnv>({ hub: (env) => hubClient(env.HUB) });

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<WorkerEnv>;
