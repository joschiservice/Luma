import { availableParallelism } from 'node:os';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'backend-e2e',
    environment: 'node',
    include: ['e2e/**/*.e2e.mjs'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Each file provisions databases and processes; leave capacity for those services.
    maxWorkers: Math.min(
      6,
      Math.max(1, Math.floor(availableParallelism() / 2)),
    ),
    sequence: { hooks: 'stack' },
  },
});
