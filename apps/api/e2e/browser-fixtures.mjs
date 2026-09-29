import { test as base } from '@playwright/test';

import { useBrowserResources } from './browser-resources.mjs';

/** Runs browser journeys with worker-owned Chromium and per-test resources. */
export const test = base.extend({
  resources: [useBrowserResources, { timeout: 30_000 }],
});

export { expect } from '@playwright/test';
