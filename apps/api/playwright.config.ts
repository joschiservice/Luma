import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

import { defineConfig } from '@playwright/test';

const artifacts = fileURLToPath(
  new URL('../../.luma/playwright/', import.meta.url),
);

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.browser.mjs',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 120_000,
  workers: Math.min(6, Math.max(1, Math.floor(availableParallelism() / 2))),
  outputDir: `${artifacts}results`,
  reporter: [
    ['list'],
    ['html', { outputFolder: `${artifacts}report`, open: 'never' }],
    ['json', { outputFile: `${artifacts}results.json` }],
  ],
  use: {
    browserName: 'chromium',
    headless: true,
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
