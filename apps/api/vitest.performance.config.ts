import { configDefaults, defineConfig } from 'vitest/config';

import journeys from './vitest.e2e.config.ts';

// Timing scenarios run one file at a time, so their measurements do not compete with each other.
export default defineConfig({
  test: {
    ...journeys.test,
    name: 'backend-performance',
    include: ['e2e/**/*.performance.e2e.mjs'],
    exclude: configDefaults.exclude,
    maxWorkers: 1,
  },
});
