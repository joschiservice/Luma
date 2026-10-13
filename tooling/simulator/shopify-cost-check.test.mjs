import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMemoryStore, createTransport } from '@luma/simulator-core';
import { rateLimit, shopify } from '@luma/simulator-shopify';

import { checkReadCosts, costProblems } from '../shopify/read-costs.mjs';

const domain = 'luma-cost-check.myshopify.com';
const config = {
  shop: domain,
  name: 'Luma Cost Check',
  currency: 'EUR',
  orderPrefix: 'K',
  locations: [{ id: '1', name: 'Hamburg Hub' }],
  scopes: [
    'read_orders',
    'read_all_orders',
    'read_products',
    'read_inventory',
    'read_inventory_transfers',
    'read_inventory_shipments',
    'read_customers',
    'read_returns',
    'read_locations',
    'read_merchant_managed_fulfillment_orders',
  ],
};

/** Serves the simulated shop and reports each request's requested cost, as Shopify does. */
function simulatedShop(scopes = config.scopes) {
  const store = createMemoryStore();
  const context = () => ({
    store,
    now: Date.now(),
    wallTime: Date.now(),
    instance: 'shopify',
    config: { ...config, scopes },
    indexLagMs: 0,
    notify: () => {},
  });

  return createTransport(async (request) =>
    rateLimit.annotate(
      await shopify.handle(context(), request),
      rateLimit.cost(request),
      rateLimit.capacity,
    ),
  );
}

test('every authorized collection read query reports Shopify cost beside the simulator estimate', async () => {
  const report = await checkReadCosts({
    shop: domain,
    accessToken: 'synthetic',
    customerAccess: { contact: true, address: true },
    fetch: simulatedShop(),
  });

  assert.deepEqual(report.failures, []);
  for (const capability of [
    'orders.read',
    'products.read',
    'inventory.read',
    'inventory.transfers.read',
    'inventory.shipments.read',
    'fulfillment.read',
    'returns.read',
    'customers.read',
  ])
    assert.ok(
      report.queries.some((query) => query.capability === capability),
      capability,
    );
  assert.ok(
    report.skipped.some(
      (item) =>
        item.capability === 'returns.created.read' &&
        item.reason.includes('exact target'),
    ),
  );
  for (const query of report.queries)
    assert.equal(query.shopify, query.simulator, query.operation);
  assert.deepEqual(costProblems(report), []);
});

test('a query Shopify charges more than the simulator estimates is a problem', async () => {
  const fetch = simulatedShop();
  const report = await checkReadCosts({
    shop: domain,
    accessToken: 'synthetic',
    customerAccess: { contact: true, address: true },
    // Shopify's model charging one more point than the simulator's.
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      const body = await response.json();
      if (body.extensions?.cost) body.extensions.cost.requestedQueryCost += 1;

      return Response.json(body, { status: response.status });
    },
  });

  assert.equal(costProblems(report).length, report.queries.length);
});

test('verified scopes and explicit protected customer approval bound collection probes', async () => {
  const report = await checkReadCosts({
    shop: domain,
    accessToken: 'synthetic',
    fetch: simulatedShop(['read_products']),
  });
  assert.deepEqual(report.failures, []);
  assert.deepEqual(
    [...new Set(report.queries.map((query) => query.capability))],
    ['installation.verify', 'products.read'],
  );
  assert.ok(
    report.skipped.some(
      (item) =>
        item.capability === 'inventory.shipments.read' &&
        item.reason.includes('verified token'),
    ),
  );
  assert.ok(
    report.skipped.some(
      (item) =>
        item.capability === 'customers.read' &&
        item.reason.includes('explicitly approved'),
    ),
  );
});
