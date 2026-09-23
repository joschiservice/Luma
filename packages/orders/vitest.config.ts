import { defineConfig } from 'vitest/config';

export default defineConfig({
  ssr: {
    resolve: { conditions: ['luma-source', 'node', 'development|production'] },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
