import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'backend-e2e',
    environment: 'node',
    include: ['e2e/**/*.e2e.mjs'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    sequence: { hooks: 'stack' },
  },
});
