import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Synthesizing a stack bundles the host files and runs every cdk-nag rule.
    testTimeout: 60_000,
  },
});
