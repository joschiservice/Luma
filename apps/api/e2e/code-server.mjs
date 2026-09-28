import { fileURLToPath } from 'node:url';

process.env.LUMA_CODE_RUNTIME_DIR = fileURLToPath(
  new URL('../../../.luma/code-runtime/', import.meta.url),
);
await import('./connections-server.mjs');
