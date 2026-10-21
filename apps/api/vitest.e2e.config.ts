import { availableParallelism } from 'node:os';

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'backend-e2e',
    environment: 'node',
    include: ['e2e/**/*.e2e.mjs'],
    // Timing scenarios run alone in vitest.performance.config.ts.
    exclude: [...configDefaults.exclude, 'e2e/**/*.performance.e2e.mjs'],
    // Migrates one template database; each journey copies it instead of migrating.
    globalSetup: ['e2e/template-database.mjs'],
    // Lists journeys that passed only after a retry (`pnpm test:full` retries once).
    reporters: ['default', './e2e/flaky-reporter.mjs'],
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
