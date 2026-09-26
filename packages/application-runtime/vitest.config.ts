import { configDefaults, defineConfig } from 'vitest/config';

import appTests from './tsconfig.apps.json' with { type: 'json' };

export default defineConfig({
  ssr: {
    resolve: { conditions: ['luma-source', 'node', 'development|production'] },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...appTests.exclude],
  },
});
