import { fileURLToPath } from 'node:url';

import { defineConfig } from '@playwright/test';

import journeys from './playwright.config.ts';

const artifacts = fileURLToPath(
  new URL('../../.luma/playwright/performance/', import.meta.url),
);

// Timing scenarios run one test at a time, so their measurements do not compete with each other.
export default defineConfig({
  ...journeys,
  testMatch: '**/*.performance.browser.mjs',
  testIgnore: [],
  workers: 1,
  outputDir: `${artifacts}results`,
  reporter: [
    ['list'],
    ['html', { outputFolder: `${artifacts}report`, open: 'never' }],
    ['json', { outputFile: `${artifacts}results.json` }],
  ],
});
