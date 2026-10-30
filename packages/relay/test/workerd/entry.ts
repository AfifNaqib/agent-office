// TEST ONLY Worker entry (see ./wrangler.jsonc): the real app, DO and hub client,
// with Access keys from the TEST_ACCESS_JWKS var (a public JWKS the test signs
// against) instead of the team certs URL. Everything else is production code.
import { createLocalJWKSet, type JSONWebKeySet } from 'jose';
import { createApp } from '../../src/app.js';
import { OfficeHub } from '../../src/hub.js';
import { hubClient } from '../../src/hubClient.js';
import type { RelayBindings } from '../../src/types.js';

export { OfficeHub };

interface TestEnv extends RelayBindings {
  readonly HUB: DurableObjectNamespace<OfficeHub>;
  readonly TEST_ACCESS_JWKS?: string;
}

let app: ReturnType<typeof createApp<TestEnv>> | undefined;

export default {
  fetch: (request, env, ctx) => {
    app ??= createApp<TestEnv>({
      hub: (e) => hubClient(e.HUB),
      accessKeys: () => createLocalJWKSet(JSON.parse(env.TEST_ACCESS_JWKS ?? '{"keys":[]}') as JSONWebKeySet),
    });
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<TestEnv>;
