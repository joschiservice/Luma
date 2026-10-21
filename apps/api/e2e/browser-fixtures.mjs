import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { test as base } from '@playwright/test';

import { useBrowserResources } from './browser-resources.mjs';
import { apiDirectory, availablePort } from './helpers.mjs';

/**
 * Starts the worker's web server once. Its `/api` requests go to the API the current journey
 * routes them to, so journeys in one worker share the server but never each other's API.
 */
// Playwright reads fixture dependencies from the first parameter's pattern; this has none.
// eslint-disable-next-line no-empty-pattern
async function useWebServer({}, use) {
  const port = await availablePort();
  const child = spawn(process.execPath, ['e2e/web-server.mjs'], {
    cwd: apiDirectory,
    env: { PATH: process.env.PATH, TEST_WEB_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout.on('data', (data) => (output += data));
  child.stderr.on('data', (data) => (output += data));
  const exited = once(child, 'exit');
  /** Resolves with the server's next message of this type, or rejects if it exits first. */
  const next = (type) =>
    Promise.race([
      new Promise((resolve) => {
        const listener = (message) => {
          if (message?.type !== type) return;
          child.off('message', listener);
          resolve(message);
        };
        child.on('message', listener);
      }),
      exited.then(() => {
        throw new Error(`Web server exited before ${type}:\n${output}`);
      }),
    ]);
  await next('listening');
  try {
    await use({
      origin: `http://127.0.0.1:${port}`,
      async route(apiOrigin) {
        const set = next('target-set');
        child.send({ type: 'target', origin: apiOrigin });
        await set;
      },
    });
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
}

/**
 * Runs browser journeys with worker-owned Chromium, a worker-owned web server and per-test
 * resources. `web.origin` is the app's address; call `web.route(apiOrigin)` with the journey's
 * API before opening pages.
 */
export const test = base.extend({
  resources: [useBrowserResources, { timeout: 30_000 }],
  webServer: [useWebServer, { scope: 'worker', timeout: 60_000 }],
  web: async ({ webServer }, use) => {
    await use(webServer);
    // A later journey in this worker must not reach this journey's API.
    await webServer.route(undefined);
  },
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
