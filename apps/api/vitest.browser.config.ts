import { availableParallelism } from 'node:os';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'identity-browser',
    environment: 'node',
    include: ['e2e/**/*.browser.mjs'],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    // Each file starts Chromium and a web server as well as its API fixtures.
    maxWorkers: Math.min(
      6,
      Math.max(1, Math.floor(availableParallelism() / 2)),
    ),
    sequence: { hooks: 'stack' },
  },
});
