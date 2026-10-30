// `npm run bridge`: starts the PC bridge on 127.0.0.1:47821 (or the configured port).
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from './config.js';
import { consoleLogger } from './log.js';
import { startBridge } from './server.js';

// The bundle runs from packages/bridge/dist, so the web build is ../../web/dist.
const WEB_DIR = fileURLToPath(new URL('../../web/dist/', import.meta.url));

async function main(): Promise<void> {
  const logger = consoleLogger();
  const config = loadConfig(process.env);
  let bridge;
  try {
    bridge = await startBridge({ eventsDir: config.eventsDir, token: config.token, port: config.port, logger, webDir: WEB_DIR, relay: config.relay });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new ConfigError(`port ${config.port} is already in use (is another bridge running?)`);
    }
    throw err;
  }
  logger.info(`listening on http://${bridge.host}:${bridge.port} (open it for the office; events in ${config.eventsDir}, token in ${config.tokenFile})`);
  if (!config.relay) logger.info('relay forwarding off (set relayUrl and bridgeToken in config.json to send PC sessions to the phone)');
  const shutdown = (): void => {
    logger.info('shutting down');
    void bridge.stop().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  // Only ConfigError messages are written by us and known to be free of secrets.
  process.stderr.write(`bridge: ${err instanceof ConfigError ? err.message : 'failed to start'}\n`);
  process.exit(1);
});
