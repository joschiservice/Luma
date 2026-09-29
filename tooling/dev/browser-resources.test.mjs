import assert from 'node:assert/strict';
import { test } from 'node:test';

import { useBrowserResources } from '../../apps/api/e2e/browser-resources.mjs';

test('browser resources close contexts before earlier services and keep cleaning after a failure', async () => {
  const order = [];
  let failedDuringCleanup;
  await assert.rejects(
    useBrowserResources(
      {
        browser: {
          newContext: async () => ({
            close: async () => order.push('context'),
          }),
        },
      },
      async (resources) => {
        resources.onTestFinished(() => {
          failedDuringCleanup = resources.failed;
          order.push('database');
        });
        await resources.newContext({});
        resources.onTestFinished(() => {
          order.push('service');
          throw new Error('shutdown failed');
        });
      },
      { status: 'passed', expectedStatus: 'passed' },
    ),
    AggregateError,
  );
  assert.deepEqual(order, ['service', 'context', 'database']);
  assert.equal(failedDuringCleanup, true);
});

test('browser resources expose failures and still clean up when the test throws', async () => {
  let closed = false;
  await assert.rejects(
    useBrowserResources(
      { browser: {} },
      async (resources) => {
        assert.equal(resources.failed, true);
        resources.onTestFinished(() => {
          closed = true;
        });
        throw new Error('test failed');
      },
      { status: 'failed', expectedStatus: 'passed' },
    ),
    /test failed/,
  );
  assert.equal(closed, true);
});
