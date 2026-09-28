import assert from 'node:assert/strict';
import { test } from 'node:test';

import { observeProviders, startObservations } from './observations.mjs';

test('only observes permitted simulated reads and continues after a persistence failure', async () => {
  const reads = [];
  const errors = [];
  const connection = {
    id: 'jtl',
    status: 'active',
    permissions: [
      'orders.read',
      'products.read',
      'inventory.read',
      'orders.shipping-method.write',
    ],
    granted: ['orders.read', 'products.read', 'orders.shipping-method.write'],
  };
  await observeProviders({
    cursors: new Map(),
    context: async () => ({}),
    installations: {
      list: async () => [
        connection,
        { ...connection, id: 'live' },
        { ...connection, id: 'shopify', status: 'disconnected' },
      ],
    },
    manifest: { connections: { jtl: 'jtl', shopify: 'shopify' } },
    capabilities: {
      read: async (_actor, request) => {
        reads.push(request);

        return { ok: true, value: { nextCursor: null } };
      },
    },
    recordRead: async (_actor, _id, capability) => {
      if (capability === 'orders.read') throw new Error('Storage failed');
    },
    onError: (error) => errors.push(error),
  });
  assert.deepEqual(
    reads.map(({ capability }) => capability),
    ['orders.read', 'products.read'],
  );
  assert.equal(errors.length, 1);
});

test('collects later order and fulfillment pages and stops repeated cursors', async () => {
  const reads = [];
  const errors = [];
  const options = {
    cursors: new Map(),
    context: async () => ({}),
    installations: {
      list: async () => [
        {
          id: 'jtl',
          status: 'active',
          permissions: ['orders.read', 'fulfillment.read', 'products.read'],
          granted: ['orders.read', 'fulfillment.read', 'products.read'],
        },
      ],
    },
    manifest: { connections: { jtl: 'jtl' } },
    capabilities: {
      read: async (_actor, request) => {
        reads.push([request.capability, request.input.cursor]);

        return {
          ok: true,
          value: {
            nextCursor:
              request.capability === 'orders.read' && request.input.cursor
                ? null
                : 'next-page',
          },
        };
      },
    },
    recordRead: async () => {},
    onError: (error) => errors.push(error.message),
  };
  await observeProviders(options);
  await observeProviders(options);
  await observeProviders(options);
  assert.deepEqual(reads, [
    ['orders.read', undefined],
    ['fulfillment.read', undefined],
    ['products.read', undefined],
    ['orders.read', 'next-page'],
    ['fulfillment.read', 'next-page'],
    ['products.read', undefined],
    ['orders.read', undefined],
    ['fulfillment.read', undefined],
    ['products.read', undefined],
  ]);
  assert.deepEqual(errors, ['Simulator observation pagination did not finish']);
});

test('collector starts immediately, serializes passes, and drains before shutdown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release;
  let passes = 0;
  const stop = startObservations(() => {
    passes++;

    return new Promise((resolve) => {
      release = resolve;
    });
  }, assert.fail);
  await Promise.resolve();
  assert.equal(passes, 1);
  t.mock.timers.tick(30000);
  assert.equal(passes, 1);
  let stopped = false;
  const stopping = stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await stopping;
  t.mock.timers.tick(30000);
  assert.equal(passes, 1);
});
