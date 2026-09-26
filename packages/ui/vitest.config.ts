import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig, mergeConfig } from 'vitest/config';

import viteConfig from './vite.config.ts';

export default mergeConfig(
  viteConfig,
  defineConfig({
    plugins: [
      storybookTest({
        configDir: fileURLToPath(new URL('./.storybook', import.meta.url)),
        storybookScript: 'pnpm storybook',
      }),
    ],
    test: {
      name: 'storybook',
      exclude: ['jtl', 'shopify'].every((app) =>
        existsSync(new URL(`../apps/${app}/package.json`, import.meta.url)),
      )
        ? []
        : ['../../apps/web/src/features/connections/*.stories.tsx'],
      browser: {
        enabled: true,
        provider: playwright(),
        headless: true,
        instances: [{ browser: 'chromium' }],
      },
    },
  }),
);
