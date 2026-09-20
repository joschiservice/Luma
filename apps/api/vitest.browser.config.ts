import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'identity-browser',
    environment: 'node',
    include: ['e2e/**/*.browser.mjs'],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    sequence: { hooks: 'stack' },
  },
});
