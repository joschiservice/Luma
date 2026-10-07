import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { createJtlConnector } from '@luma/app-jtl';
import { createShopifyConnector } from '@luma/app-shopify';
import { createCapabilityRuntime } from '@luma/connections/adapters';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';
import { createMemoryStore, createTransport } from '@luma/simulator-core';
import { jtl } from '@luma/simulator-jtl';
import { rateLimit, shopify } from '@luma/simulator-shopify';

// Run after building the app and simulator packages. Synthetic latency is per HTTP request.
const latencyMs = Number(process.env.BENCHMARK_LATENCY_MS ?? 10);
const size = Number(process.env.BENCHMARK_RECORDS ?? 25);
// Requested records per page; adapters may return fewer, as Shopify does above 25.
const pageSize = Number(process.env.BENCHMARK_PAGE_SIZE ?? 25);
const provider = process.env.BENCHMARK_PROVIDER ?? 'shopify';
const mode = process.env.BENCHMARK_MODE ?? 'paged';
const capabilities = (
  process.env.BENCHMARK_CAPABILITIES ??
  (provider === 'jtl'
    ? 'orders.read,products.read,inventory.read,fulfillment.read'
    : 'orders.read,products.read,inventory.read,customers.read,fulfillment.read,returns.read')
).split(',');
assert.ok(['shopify', 'jtl'].includes(provider));
assert.ok(['paged', 'bulk'].includes(mode));
assert.ok(Number.isSafeInteger(size) && size > 0 && size <= 100_000);
assert.ok(Number.isSafeInteger(pageSize) && pageSize > 0 && pageSize <= 100);
assert.ok(Number.isFinite(latencyMs) && latencyMs >= 0);
const rateEnabled = process.env.BENCHMARK_RATE_LIMIT === '1';
const tenantId = '00000000-0000-4000-8000-000000000001';
const connectionId = '00000000-0000-4000-8000-000000000002';
const tenant = makeTenantContext(
  { userId: 'owner', sessionId: 'session' },
  {
    id: tenantId,
    name: 'Benchmark',
    slug: 'benchmark',
    status: 'active',
    dataRegion: 'EU',
  },
  builtInMembership(
    { id: 'member', organizationId: tenantId, userId: 'owner' },
    'owner',
  ),
  'benchmark',
);
const config =
  provider === 'jtl'
    ? {
        warehouses: [{ id: '1', name: 'Warehouse' }],
        shippingMethods: [{ id: '7', name: 'Standard' }],
      }
    : {
        shop: 'benchmark.myshopify.com',
        name: 'Benchmark',
        currency: 'EUR',
        orderPrefix: 'B',
        locations: [{ id: '1', name: 'Warehouse' }],
        scopes: [
          'read_orders',
          'read_all_orders',
          'read_products',
          'read_inventory',
          'read_customers',
          'read_returns',
          'read_merchant_managed_fulfillment_orders',
        ],
      };
const store = createMemoryStore();
let now = Date.now() - 3_600_000;
const context = () => ({
  store,
  now,
  wallTime: Date.now(),
  instance: 'benchmark',
  config,
  indexLagMs: 0,
  notify: () => undefined,
});
const run = (command) => {
  now += 1000;

  return (provider === 'jtl' ? jtl : shopify).command(context(), command);
};
if (provider === 'jtl') {
  await run({
    kind: 'seed-catalog',
    suppliers: [],
    items: Array.from({ length: size }, (_, i) => ({
      id: String(i + 1),
      sku: `SKU-${i}`,
      name: `Product ${i}`,
      price: '10.00',
      gtin: null,
      manufacturer: 'Synthetic',
      active: true,
      shopActive: true,
      stock: { 1: 100 },
      suppliers: [],
    })),
  });
  if (
    capabilities.some((item) =>
      ['orders.read', 'fulfillment.read'].includes(item),
    )
  )
    for (let i = 0; i < size; i++) {
      const order = await run({
        kind: 'order',
        externalNumber: `B-${i}`,
        lines: [{ itemId: String(i + 1), quantity: 2, price: 10 }],
        shippingMethodId: '7',
        currency: 'EUR',
        paid: true,
      });
      await run({
        kind: 'ship',
        id: order.id,
        warehouse: '1',
        trackingNumber: String(i),
        trackingUrl: `https://example.test/${i}`,
      });
    }
} else {
  await run({
    kind: 'seed-catalog',
    products: Array.from({ length: size }, (_, i) => ({
      id: String(i + 1),
      title: `Product ${i}`,
      vendor: 'Benchmark',
      productType: 'Goods',
      published: true,
      variants: [
        {
          id: String(i + 1),
          sku: `SKU-${i}`,
          title: 'Default Title',
          price: '10.00',
          barcode: null,
          stock: { 1: 100 },
        },
      ],
    })),
  });
  if (
    capabilities.some((item) =>
      [
        'orders.read',
        'customers.read',
        'fulfillment.read',
        'returns.read',
      ].includes(item),
    )
  )
    for (let i = 0; i < size; i++) {
      const customer = await run({
        kind: 'customer',
        customer: {
          firstName: 'Synthetic',
          lastName: String(i),
          email: `person-${i}@example.test`,
          phone: null,
          address: {
            address1: 'Synthetic',
            city: 'Berlin',
            zip: '10115',
            countryCode: 'DE',
          },
        },
      });
      const order = await run({
        kind: 'order',
        customer: customer.id,
        lines: [{ variant: String(i + 1), quantity: 2, price: '10.00' }],
        location: '1',
        shipping: 'standard',
        financialStatus: 'PAID',
      });
      await run({
        kind: 'fulfill',
        order: order.id,
        carrier: 'Synthetic',
        trackingNumber: String(i),
      });
      await run({
        kind: 'return',
        order: order.id,
        lines: [{ lineItem: order.lines[0].id, quantity: 1 }],
        reason: 'Synthetic',
      });
      await run({ kind: 'return-approve', order: order.id });
      await run({ kind: 'return-receive', order: order.id });
      await run({ kind: 'refund', order: order.id, outcome: 'success' });
    }
}
let requests = 0;
let throttles = 0;
let available = rateLimit.capacity;
let restoredAt = Date.now();
let requestedCost = 0;
const fetch = createTransport(async (request) => {
  requests++;
  if (latencyMs) await delay(latencyMs);
  if (provider === 'jtl') return jtl.handle(context(), request);
  const cost = rateLimit.cost(request);
  requestedCost = Math.max(requestedCost, cost);
  assert.ok(
    cost <= 1000,
    `Query cost ${cost} exceeds Shopify's single-query limit`,
  );
  available = Math.min(
    rateLimit.capacity,
    available + ((Date.now() - restoredAt) * rateLimit.restorePerSecond) / 1000,
  );
  restoredAt = Date.now();
  if (rateEnabled && cost > available) {
    throttles++;

    return rateLimit.reject(cost, available);
  }
  const response = await shopify.handle(context(), request);
  if (rateEnabled) available -= rateLimit.actualCost(response) ?? cost;

  return rateLimit.annotate(
    response,
    cost,
    rateEnabled ? available : rateLimit.capacity,
  );
});
const connector =
  provider === 'jtl'
    ? createJtlConnector({
        tenantId,
        connectionId,
        connection: {
          kind: 'onprem',
          baseUrl: 'https://jtl.synthetic.invalid/api/eazybusiness/',
          appId: 'LumaBenchmark',
          appVersion: '1',
          challengeCode: 'synthetic',
          apiKey: async () => 'synthetic-only',
        },
        fetch,
        recordObservations: async () => undefined,
      })
    : createShopifyConnector({
        tenantId,
        connectionId,
        shop: config.shop,
        accessToken: async () => 'synthetic',
        fetch,
        customerAccess: { contact: true, address: true },
        recordObservations: async () => undefined,
      });
const runtime = createCapabilityRuntime({
  resolve: async () => connector,
  record: async () => undefined,
});
for (const capability of capabilities) {
  requests = 0;
  requestedCost = 0;
  const start = performance.now();
  let cursor;
  const key = crypto.randomUUID();
  let deferred;
  let records = 0;
  let pages = 0;
  do {
    const result = await runtime.read(tenant, {
      connectionId,
      capability,
      version: '0',
      input: {
        limit: pageSize,
        ...(cursor ? { cursor } : {}),
        ...(mode === 'bulk' ? { historyImport: { key, chunkSize: 500 } } : {}),
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    deferred = result.value.deferred === true;
    if (deferred) await delay(result.value.retryAfterMs ?? 2000);
    records += result.value.items.length;
    pages++;
    cursor = result.value.nextCursor;
  } while (cursor || deferred);
  const seconds = (performance.now() - start) / 1000;
  if (rateEnabled)
    assert.equal(
      throttles,
      0,
      'Budget pacing must prevent sustained throttling',
    );
  console.log(
    JSON.stringify({
      provider,
      mode,
      capability,
      records,
      pages,
      requests,
      throttles,
      rateEnabled,
      requestsPerPage: requests / pages,
      seconds: +seconds.toFixed(3),
      recordsPerSecond: +(records / seconds).toFixed(1),
      maxRequestedCost: requestedCost,
      latencyMs,
    }),
  );
}
