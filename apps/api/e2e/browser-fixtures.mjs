import { test as base } from '@playwright/test';

import { useBrowserResources } from './browser-resources.mjs';

/** Runs browser journeys with worker-owned Chromium and per-test resources. */
export const test = base.extend({
  resources: [useBrowserResources, { timeout: 30_000 }],
});

export { expect } from '@playwright/test';

/**
 * Resolves with the view key once a list page has stored a saved view without unsaved changes
 * as the member's remembered view. List pages store it about a second after the change, so
 * start waiting before saving the view and await this before reopening the list.
 */
export async function rememberedView(page, domain) {
  const response = await page.waitForResponse((candidate) => {
    const request = candidate.request();
    if (
      request.method() !== 'PUT' ||
      !candidate.url().endsWith(`/collections/${domain}/state`) ||
      !candidate.ok()
    )
      return false;
    const state = request.postDataJSON()?.state;

    return !!state?.view && !state.view.startsWith('builtin:') && !state.draft;
  });

  return response.request().postDataJSON().state.view;
}
