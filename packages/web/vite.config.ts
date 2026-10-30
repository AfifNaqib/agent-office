import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Same as vitest.config.mjs: use core's source, so no core build step is needed.
const coreSrc = fileURLToPath(new URL('../core/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: { alias: { '@agent-office/core': coreSrc } },
  // Every build starts from an empty dist/, so old hashed files never pile up in dist/assets (UI-L9).
  build: { emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});
