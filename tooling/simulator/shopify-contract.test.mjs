import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  createInstallationVerifier,
  createShopifyConnector,
  createShopifyRecordReader,
} from '@luma/app-shopify';
import { createCapabilityRuntime } from '@luma/connections/adapters';
import { makeTenantContext } from '@luma/identity/composition';
import {
  charge,
  createMemoryStore,
  createTransport,
} from '@luma/simulator-core';
import {
  rateLimit,
  readOrder,
  readStock,
  shopify,
} from '@luma/simulator-shopify';

import { createFulfillmentProvider } from '../../packages/apps/shopify/dist/infrastructure/fulfillment-recovery-provider.js';
import { createInventoryCorrectionProvider } from '../../packages/apps/shopify/dist/infrastructure/inventory-correction-provider.js';
import { createClient } from '../../packages/connectors/shopify/dist/index.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const connectionId = '00000000-0000-4000-8000-000000000002';
const domain = 'luma-contract.myshopify.com';
const tenant = makeTenantContext(
  { userId: 'owner', sessionId: 'session' },
  {
    id: tenantId,
    name: 'Test',
    slug: 'test',
    status: 'active',
    dataRegion: 'EU',
  },
  { id: 'member', organizationId: tenantId, userId: 'owner', role: 'owner' },
  'request',
);
const config = {
  shop: domain,
  name: 'Luma Contract',
  currency: 'EUR',
  orderPrefix: 'C',
  locations: [
    { id: '1', name: 'Hamburg Hub' },
    { id: '2', name: 'Vienna Depot' },
  ],
  scopes: [
    'read_orders',
    'read_all_orders',
    'read_products',
    'read_inventory',
    'write_inventory',
    'read_customers',
    'read_returns',
    'read_locations',
    'read_merchant_managed_fulfillment_orders',
    'read_assigned_fulfillment_orders',
    'read_third_party_fulfillment_orders',
    'write_merchant_managed_fulfillment_orders',
  ],
};
const catalog = [
  {
    id: '10',
    title: 'Canvas tote',
    vendor: 'Luma Goods',
    productType: 'Bags',
    published: true,
    variants: [
      {
        id: '11',
        sku: 'TOTE-NAT',
        title: 'Natural',
        price: '24.00',
        barcode: '4006381333931',
        stock: { 1: 100, 2: 20 },
      },
      {
        id: '12',
        sku: 'TOTE-BLK',
        title: 'Black',
        price: '26.50',
        barcode: null,
        stock: { 1: 40, 2: 10 },
      },
    ],
  },
  {
    id: '20',
    title: 'Linen shirt',
    vendor: 'Nordwind',
    productType: 'Shirts',
    published: false,
    variants: [
      {
        id: '21',
        sku: 'SHIRT-M',
        title: 'Default Title',
        price: '59.90',
        barcode: null,
        stock: { 1: 10 },
      },
    ],
  },
];
const gid = (type, id) => `gid://shopify/${type}/${id}`;
const ref = (externalId) => ({ externalId, scopeKey: '' });
const tracking = (number) => ({
  carrier: 'DHL',
  trackingNumber: number,
  trackingUrl: `https://track.example/${number}`,
});

/**
 * Creates a simulated shop behind a fetch transport that applies Shopify's rate limit as the
 * simulator host does: admission by requested cost, then a refund down to the actual cost.
 */
function createShop() {
  const store = createMemoryStore();
  const bucket = { available: rateLimit.capacity, at: Date.now() };
  const shop = {
    store,
    bucket,
    /** Applies an incompatible API change to successful responses. */
    drift: false,
    events: [],
    now: Date.now() - 3_600_000,
    context() {
      return {
        store,
        now: shop.now,
        wallTime: Date.now(),
        instance: 'shopify',
        config,
        indexLagMs: 0,
        notify: (event) => shop.events.push(event),
      };
    },
    run(command) {
      shop.now += 1000;

      return shopify.command(shop.context(), command);
    },
    fetch: createTransport(async (request) => {
      const cost = rateLimit.cost(request);
      if (!charge(rateLimit, bucket, cost, Date.now()))
        return rateLimit.reject(cost, bucket.available);

      const handled = await shopify.handle(shop.context(), request);
      const response = shop.drift ? shopify.drift(handled) : handled;
      bucket.available = Math.min(
        rateLimit.capacity,
        bucket.available + cost - (rateLimit.actualCost(response) ?? cost),
      );

      return rateLimit.annotate(response, cost, bucket.available);
    }),
  };

  return shop;
}

/** Seeds a catalog, customers and orders in every lifecycle state Luma reads. */
async function seed(shop) {
  await shop.run({ kind: 'seed-catalog', products: catalog });
  const anna = await shop.run({
    kind: 'customer',
    customer: {
      firstName: 'Anna',
      lastName: 'Müller',
      email: 'anna@customer.example',
      phone: '+49 151 0000001',
      address: {
        address1: 'Hauptstraße 1',
        city: 'Berlin',
        zip: '10115',
        countryCode: 'DE',
      },
    },
  });
  const leon = await shop.run({
    kind: 'customer',
    customer: {
      firstName: 'Leon',
      lastName: 'Weber',
      email: 'leon@customer.example',
      phone: '+43 660 0000002',
      address: {
        address1: 'Seestraße 2',
        city: 'Wien',
        zip: '1010',
        countryCode: 'AT',
      },
    },
  });
  const order = (extra) =>
    shop.run({
      kind: 'order',
      customer: anna.id,
      lines: [
        { variant: '11', quantity: 2, price: '24.00' },
        { variant: '12', quantity: 1, price: '26.50' },
      ],
      location: '1',
      shipping: 'standard',
      financialStatus: 'PAID',
      ...extra,
    });
  const shipped = await order({ shipping: 'express' });
  await shop.run({
    kind: 'fulfill',
    order: shipped.id,
    lines: [{ lineItem: shipped.lines[0].id, quantity: 2 }],
    ...tracking('SHIP-1'),
    estimatedDeliveryAt: shop.now + 86_400_000,
  });
  const shipment = await shop.run({
    kind: 'fulfill',
    order: shipped.id,
    ...tracking('SHIP-2'),
  });
  await shop.run({
    kind: 'shipment-status',
    fulfillment: shipment.id,
    status: 'DELIVERED',
  });
  const returned = await order({ customer: leon.id });
  await shop.run({ kind: 'fulfill', order: returned.id, ...tracking('RET-1') });
  await shop.run({
    kind: 'return',
    order: returned.id,
    lines: [{ lineItem: returned.lines[0].id, quantity: 1 }],
    reason: 'Too small',
  });
  await shop.run({ kind: 'return-approve', order: returned.id });
  await shop.run({ kind: 'return-receive', order: returned.id });
  await shop.run({ kind: 'refund', order: returned.id, outcome: 'failure' });
  await shop.run({ kind: 'refund', order: returned.id, outcome: 'success' });
  const held = await order({ holds: ['INCORRECT_ADDRESS'] });
  const scheduled = await order({ fulfillAt: shop.now + 7 * 86_400_000 });
  const movable = await order({
    lines: [{ variant: '12', quantity: 3, price: '26.50' }],
  });
  const cancelled = await order({ financialStatus: 'PENDING' });
  await shop.run({ kind: 'cancel', order: cancelled.id, reason: 'DECLINED' });
  const work = async (orderId) =>
    gid(
      'FulfillmentOrder',
      (
        await shop.store.page({
          kind: 'FulfillmentOrder',
          parent: orderId,
          limit: 1,
        })
      ).items[0].id,
    );

  return {
    anna,
    leon,
    shipped,
    shipment,
    returned,
    held,
    scheduled,
    movable,
    cancelled,
    work,
  };
}

/** Composes the real Shopify connector and returns its capability runtime's page reads. */
function pages(shop) {
  const connector = createShopifyConnector({
    tenantId,
    connectionId,
    shop: domain,
    accessToken: async () => 'synthetic',
    fetch: shop.fetch,
    customerAccess: { contact: true, address: true },
    recordObservations: async () => {},
  });
  const runtime = createCapabilityRuntime({
    resolve: async () => connector,
    record: async () => {},
  });

  return (capability, input) =>
    runtime.read(tenant, { connectionId, capability, version: '0', input });
}

/** Reads every page of a capability and checks that each page is complete. */
function reads(shop) {
  const page = pages(shop);

  return async (capability, input = {}) => {
    const items = [];
    let cursor;
    let total;
    do {
      const result = await page(capability, {
        limit: 2,
        ...input,
        ...(cursor ? { cursor } : {}),
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.value.completeness, 'complete');
      items.push(...result.value.items);
      total ??= result.value.total;
      cursor = result.value.nextCursor;
    } while (cursor);

    return { items, total };
  };
}

const byId = (items, id) => {
  const item = items.find((candidate) => candidate.source.externalId === id);
  assert.ok(item, `Missing observation ${id}`);

  return item;
};

test('simulator serves the schema the adapter is validated against', async () => {
  const [simulated, fixture] = await Promise.all(
    [
      '../../packages/simulator/shopify/admin-2026-07.graphql',
      '../../packages/apps/shopify/src/infrastructure/fixtures/admin-2026-07.graphql',
    ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')),
  );

  assert.equal(simulated, fixture);
});

test('installation verification, scope reads and lifecycle subscriptions', async () => {
  const shop = createShop();
  const verify = createInstallationVerifier({ fetch: shop.fetch });
  const granted = await verify(
    { label: 'Contract shop', target: { kind: 'shopify', shop: domain } },
    { token: 'synthetic' },
  );
  assert.deepEqual(granted.sort(), [
    'customers.read',
    'fulfillment.hold.release',
    'fulfillment.move',
    'fulfillment.open',
    'fulfillment.read',
    'inventory.available.reconcile',
    'inventory.read',
    'orders.read',
    'products.read',
    'returns.read',
  ]);

  // Mirrors the subscription and scope requests in the app's OAuth lifecycle.
  const request = createClient({
    shop: domain,
    accessToken: async () => 'synthetic',
    fetch: shop.fetch,
  });
  const uri = `https://luma.example/api/v1/shopify/changes/${tenantId}/${connectionId}`;
  const list = () =>
    request(
      'query LumaLifecycleSubscriptions { webhookSubscriptions(first: 100, topics: [ORDERS_UPDATED]) { nodes { uri } } }',
      {},
    );
  assert.deepEqual(await list(), { webhookSubscriptions: { nodes: [] } });
  const created = await request(
    'mutation LumaLifecycleWebhook($uri: String!) { webhookSubscriptionCreate(topic: ORDERS_UPDATED, webhookSubscription: { uri: $uri, format: JSON }) { webhookSubscription { id } userErrors { message } } }',
    { uri },
  );
  assert.match(
    created.webhookSubscriptionCreate.webhookSubscription.id,
    /^gid:\/\/shopify\/WebhookSubscription\/\d+$/,
  );
  assert.deepEqual(await list(), {
    webhookSubscriptions: { nodes: [{ uri }] },
  });
  const scopes = await request(
    'query LumaScopeUpdate { currentAppInstallation { accessScopes { handle } } }',
    {},
  );
  assert.deepEqual(
    scopes.currentAppInstallation.accessScopes.map((scope) => scope.handle),
    config.scopes,
  );
});

test('every read capability returns complete, parsed snapshots', async () => {
  const shop = createShop();
  const ids = await seed(shop);
  const read = reads(shop);

  const orders = await read('orders.read');
  assert.equal(orders.items.length, 6);
  assert.equal(orders.total, 6);
  assert.equal(
    new Set(orders.items.map((item) => item.source.externalId)).size,
    6,
  );
  const shipped = byId(orders.items, ids.shipped.gid);
  assert.deepEqual(shipped.data, {
    displayNumber: '#C1001',
    placedAt: shipped.data.placedAt,
    total: { amount: '74.5', currency: 'EUR' },
    status: 'completed',
    paymentStatus: 'paid',
    lines: [
      {
        id: {
          externalId: gid('LineItem', ids.shipped.lines[0].id),
          scopeKey: ids.shipped.gid,
        },
        sku: ref(gid('InventoryItem', '11')),
        quantity: { amount: '2', unit: 'each' },
        cancelledQuantity: null,
        skuCode: 'TOTE-NAT',
        title: 'Canvas tote - Natural',
      },
      {
        id: {
          externalId: gid('LineItem', ids.shipped.lines[1].id),
          scopeKey: ids.shipped.gid,
        },
        sku: ref(gid('InventoryItem', '12')),
        quantity: { amount: '1', unit: 'each' },
        cancelledQuantity: null,
        skuCode: 'TOTE-BLK',
        title: 'Canvas tote - Black',
      },
    ],
  });
  assert.equal(byId(orders.items, ids.cancelled.gid).data.status, 'cancelled');
  assert.equal(
    byId(orders.items, ids.returned.gid).data.paymentStatus,
    'partially_refunded',
  );

  const products = await read('products.read');
  assert.equal(products.total, 2);
  assert.deepEqual(byId(products.items, gid('Product', '10')).data, {
    title: 'Canvas tote',
    status: 'active',
    vendor: 'Luma Goods',
    published: true,
    skus: [
      {
        id: ref(gid('InventoryItem', '11')),
        code: 'TOTE-NAT',
        unit: 'each',
        title: 'Natural',
        price: { amount: '24.00', currency: 'EUR' },
        barcode: '4006381333931',
      },
      {
        id: ref(gid('InventoryItem', '12')),
        code: 'TOTE-BLK',
        unit: 'each',
        title: 'Black',
        price: { amount: '26.50', currency: 'EUR' },
        barcode: null,
      },
    ],
  });
  assert.equal(
    byId(products.items, gid('Product', '20')).data.skus[0].title,
    null,
  );

  const inventory = await read('inventory.read');
  assert.equal(inventory.items.length, 5);
  const tote = inventory.items.find(
    (item) =>
      item.data.sku.externalId === gid('InventoryItem', '11') &&
      item.data.location.externalId === gid('Location', '1'),
  );
  const stock = await readStock(shop.context(), '11', '1');
  assert.deepEqual(tote.data, {
    sku: ref(gid('InventoryItem', '11')),
    location: ref(gid('Location', '1')),
    unit: 'each',
    onHand: String(stock.onHand),
    reserved: String(stock.committed),
    available: String(stock.available),
    availabilityBasis: 'provider_reported',
  });

  const fulfillment = await read('fulfillment.read');
  const held = byId(fulfillment.items, await ids.work(ids.held.id));
  assert.deepEqual(held.data, {
    order: ref(ids.held.gid),
    status: 'pending',
    lines: [
      {
        orderLine: {
          externalId: gid('LineItem', ids.held.lines[0].id),
          scopeKey: ids.held.gid,
        },
        quantity: { amount: '2', unit: 'each' },
      },
      {
        orderLine: {
          externalId: gid('LineItem', ids.held.lines[1].id),
          scopeKey: ids.held.gid,
        },
        quantity: { amount: '1', unit: 'each' },
      },
    ],
    lastProgressAt: held.sourceUpdatedAt,
    progressBasis: 'source_updated',
    failureCode: null,
    kind: 'fulfillment_order',
    holds: [{ reason: 'incorrect_address' }],
    location: { id: ref(gid('Location', '1')), name: 'Hamburg Hub' },
    fulfillAt: held.data.fulfillAt,
    fulfillBy: held.data.fulfillBy,
    method: { type: 'shipping', name: 'Standard' },
  });
  assert.equal(
    byId(fulfillment.items, await ids.work(ids.shipped.id)).data.status,
    'completed',
  );
  const delivered = byId(
    fulfillment.items,
    gid('Fulfillment', ids.shipment.id),
  );
  assert.deepEqual(
    {
      status: delivered.data.status,
      kind: delivered.data.kind,
      delivery: delivered.data.delivery,
      tracking: delivered.data.tracking,
      lines: delivered.data.lines.map((line) => line.quantity.amount),
    },
    {
      status: 'delivered',
      kind: 'shipment',
      delivery: 'delivered',
      tracking: [
        {
          carrier: 'DHL',
          number: 'SHIP-2',
          url: 'https://track.example/SHIP-2',
        },
      ],
      lines: ['1'],
    },
  );
  assert.equal(
    byId(fulfillment.items, await ids.work(ids.cancelled.id)).data.status,
    'cancelled',
  );

  const returns = await read('returns.read');
  const returnItem = returns.items.find((item) => item.data.type === 'return');
  assert.deepEqual(returnItem.data, {
    type: 'return',
    order: ref(ids.returned.gid),
    name: '#C1002-R1',
    status: 'open',
    requestedAt: returnItem.data.requestedAt,
    approvedAt: returnItem.data.approvedAt,
    closedAt: null,
    declineReason: null,
    receivedAt: returnItem.data.receivedAt,
    lines: [
      {
        orderLine: {
          externalId: gid('LineItem', ids.returned.lines[0].id),
          scopeKey: ids.returned.gid,
        },
        quantity: { amount: '1', unit: 'each' },
        reason: 'Too small',
        receivedQuantity: '1',
        restockedQuantity: '1',
        refundedQuantity: '1',
        value: { amount: '24.0', currency: 'EUR' },
      },
    ],
  });
  assert.ok(returnItem.data.receivedAt);
  const refunds = returns.items.filter((item) => item.data.type === 'refund');
  assert.deepEqual(
    refunds
      .filter((item) => item.data.order.externalId === ids.returned.gid)
      .map((item) => [
        item.data.total,
        item.data.transactions.map((t) => t.status),
      ]),
    [
      [{ amount: '0.0', currency: 'EUR' }, ['failed']],
      [{ amount: '24.0', currency: 'EUR' }, ['success']],
    ],
  );

  const customers = await read('customers.read');
  assert.equal(customers.total, 2);
  assert.deepEqual(byId(customers.items, ids.anna.gid).data, {
    displayName: 'Anna Müller',
    email: 'anna@customer.example',
    phone: '+49 151 0000001',
    address: {
      line1: 'Hauptstraße 1',
      line2: null,
      city: 'Berlin',
      region: null,
      postalCode: '10115',
      country: 'DE',
    },
    state: 'enabled',
    createdAt: byId(customers.items, ids.anna.gid).data.createdAt,
    orderCount: 5,
    amountSpent: { amount: '303.0', currency: 'EUR' },
    tags: [],
    shared: { contact: true, address: true },
  });
});

test('incremental reads see only records changed since the last sync', async () => {
  const shop = createShop();
  const ids = await seed(shop);
  const read = reads(shop);
  shop.now += 60_000;
  const since = new Date(shop.now).toISOString();
  await shop.run({ kind: 'release', order: ids.held.id });
  await shop.run({ kind: 'product-update', product: '20', published: true });

  const orders = await read('orders.read', { updatedSince: since });
  assert.deepEqual(
    orders.items.map((item) => item.source.externalId),
    [ids.held.gid],
  );
  assert.equal(orders.total, 1);
  const work = await read('fulfillment.read', { updatedSince: since });
  assert.deepEqual(
    byId(work.items, await ids.work(ids.held.id)).data.holds,
    [],
  );
  const products = await read('products.read', { updatedSince: since });
  assert.deepEqual(
    products.items.map((item) => [item.source.externalId, item.data.published]),
    [[gid('Product', '20'), true]],
  );
});

test('throttling and drift fail reads the way Luma recovers from them', async () => {
  const shop = createShop();
  await seed(shop);
  const page = pages(shop);
  // A short throttle is waited out in place at Shopify's restore rate.
  shop.bucket.available = 50;
  shop.bucket.at = Date.now();
  const started = Date.now();
  assert.equal((await page('orders.read', { limit: 100 })).ok, true);
  assert.ok(Date.now() - started >= 900);
  // A longer one is returned with its delay after the last attempt, so the sync schedules the retry.
  shop.bucket.available = -500;
  shop.bucket.at = Date.now();
  const throttled = await page('orders.read', { limit: 100 });
  assert.equal(throttled.ok, false);
  assert.equal(throttled.error.code, 'rate_limited');
  assert.ok(throttled.error.retryAfterMs >= 1000);

  shop.bucket.available = rateLimit.capacity;
  shop.drift = true;
  const drifted = await page('products.read', { limit: 100 });
  assert.equal(drifted.ok, false);
  assert.equal(drifted.error.code, 'invalid_response');
});

test('inventory correction sets available stock once and refuses stale writes', async () => {
  const shop = createShop();
  await seed(shop);
  const evidence = [];
  const provider = createInventoryCorrectionProvider({
    tenantId,
    connectionId,
    shop: domain,
    accessToken: async () => 'synthetic',
    fetch: shop.fetch,
    record: async (item) => evidence.push(item),
  });
  const item = gid('InventoryItem', '12');
  const location = gid('Location', '1');
  const before = await provider.read(item, location);
  const stock = await readStock(shop.context(), '12', '1');
  assert.deepEqual(
    {
      tracked: before.tracked,
      complete: before.complete,
      available: before.available,
      locationName: before.locationName,
    },
    {
      tracked: true,
      complete: true,
      available: stock.available,
      locationName: 'Hamburg Hub',
    },
  );
  const handler = provider.capabilities['inventory.available.reconcile'];
  const invocation = (key) => ({
    tenant,
    connectionId,
    provider: 'shopify',
    idempotencyKey: key,
  });
  const input = {
    inventoryItemId: item,
    locationId: location,
    expectedRevision: before.targetRevision,
    expectedAvailable: before.available,
    available: 7,
  };
  const accepted = await handler.run(
    invocation('fix-1'),
    handler.parseInput(input),
  );
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(await readStock(shop.context(), '12', '1'), {
    onHand: 7 + stock.committed,
    committed: stock.committed,
    available: 7,
  });
  assert.equal((await provider.read(item, location)).available, 7);
  await assert.rejects(
    handler.run(invocation('fix-2'), handler.parseInput(input)),
    (error) =>
      error.failure.code === 'conflict' &&
      error.failure.dispatch === 'not_dispatched',
  );
  assert.ok(evidence.some((entry) => entry.kind === 'acceptance'));
});

test('fulfillment recovery releases holds, opens scheduled work and moves work', async () => {
  const shop = createShop();
  const ids = await seed(shop);
  const provider = createFulfillmentProvider({
    tenantId,
    connectionId,
    shop: domain,
    accessToken: async () => 'synthetic',
    fetch: shop.fetch,
    record: async () => {},
  });
  const invocation = (key) => ({
    tenant,
    connectionId,
    provider: 'shopify',
    idempotencyKey: key,
  });
  const recover = async (capability, order, extra = {}) => {
    const work = await ids.work(order.id);
    const snapshot = await provider.read(order.gid, work);
    const handler = provider.capabilities[capability];
    const input = handler.parseInput({
      orderId: order.gid,
      fulfillmentOrderId: work,
      expectedRevision: snapshot.revision,
      ...extra(snapshot),
    });

    return {
      snapshot,
      output: await handler.run(invocation(capability), input),
    };
  };

  const release = await recover(
    'fulfillment.hold.release',
    ids.held,
    (snapshot) => ({
      holdId: snapshot.holds[0].id,
    }),
  );
  assert.deepEqual(release.snapshot.actions, ['RELEASE_HOLD', 'HOLD']);
  assert.equal(release.snapshot.complete, true);
  assert.equal(release.output.status, 'accepted');
  assert.deepEqual((await readOrder(shop.context(), ids.held.id)).holds, []);

  const open = await recover('fulfillment.open', ids.scheduled, () => ({}));
  assert.equal(open.snapshot.status, 'SCHEDULED');
  assert.equal(open.output.status, 'accepted');
  const opened = await provider.read(
    ids.scheduled.gid,
    await ids.work(ids.scheduled.id),
  );
  assert.equal(opened.status, 'OPEN');

  const move = await recover('fulfillment.move', ids.movable, () => ({
    locationId: gid('Location', '2'),
  }));
  assert.deepEqual(move.snapshot.locations, [
    { id: gid('Location', '2'), name: 'Vienna Depot', movable: true },
  ]);
  assert.equal(move.output.status, 'accepted');
  assert.equal((await readOrder(shop.context(), ids.movable.id)).location, '2');
  assert.deepEqual(await readStock(shop.context(), '12', '2'), {
    onHand: 10,
    committed: 3,
    available: 7,
  });
  await assert.rejects(
    recover('fulfillment.open', ids.movable, () => ({})),
    (error) => error.failure.code === 'conflict',
  );
});

test('record explorer reads every record kind with available sections', async () => {
  const shop = createShop();
  const ids = await seed(shop);
  const read = createShopifyRecordReader({
    tenantId,
    connectionId,
    shop: domain,
    accessToken: async () => 'synthetic',
    fetch: shop.fetch,
    protectedCustomerDataApproved: true,
    protectedCustomerContactApproved: true,
  });
  const available = (detail) => {
    for (const section of detail.sections)
      assert.ok(
        ['available'].includes(section.status),
        `${detail.kind} ${section.key}: ${section.status} ${section.message}`,
      );

    return Object.fromEntries(
      detail.sections.map((section) => [section.key, section.rows]),
    );
  };

  const recent = await read('Order');
  assert.equal(available(recent).records.length, 6);
  assert.equal(recent.nextCursor, null);
  const order = available(await read('Order', ids.returned.gid));
  assert.deepEqual(order.order[0].fields, {
    Name: '#C1002',
    Created: order.order[0].fields.Created,
    Payment: 'PARTIALLY_REFUNDED',
    Fulfillment: 'FULFILLED',
    Total: '50.5 EUR',
    Outstanding: '0.0 EUR',
  });
  assert.equal(order.lines.length, 2);
  assert.deepEqual(
    order.transactions.map((row) => [row.fields.Kind, row.fields.Status]),
    [
      ['SALE', 'SUCCESS'],
      ['REFUND', 'FAILURE'],
      ['REFUND', 'SUCCESS'],
    ],
  );
  assert.equal(order.customer[0].id, ids.leon.gid);
  assert.equal(order.fulfillment.length, 1);
  assert.equal(order.returns.length, 1);
  assert.equal(order.refunds.length, 2);
  assert.ok(order.events.length >= 3);

  const customers = await read('Customer', undefined, undefined, {
    field: 'email',
    value: 'anna@customer.example',
  });
  assert.deepEqual(
    available(customers).records.map((row) => row.fields.Name),
    ['Anna Müller'],
  );
  const named = available(
    await read('Customer', undefined, undefined, {
      field: 'name',
      value: 'Weber',
    }),
  );
  assert.deepEqual(
    named.records.map((row) => row.id),
    [ids.leon.gid],
  );
  const byOrder = available(
    await read('Customer', undefined, undefined, {
      field: 'order',
      value: '#C1002',
    }),
  );
  assert.deepEqual(
    byOrder.records.map((row) => row.id),
    [ids.leon.gid],
  );
  const customer = available(await read('Customer', ids.anna.gid));
  assert.equal(customer.contact[0].fields.Email, 'anna@customer.example');
  assert.equal(customer.orders.length, 5);
  assert.equal(customer.orders[0].fields.Name, '#C1006');

  assert.equal(available(await read('Product')).records.length, 2);
  const product = available(await read('Product', gid('Product', '10')));
  assert.equal(product.variants.length, 2);
  assert.deepEqual(
    available(await read('ProductVariant', gid('ProductVariant', '11')))
      .variant[0].fields,
    { Title: 'Natural', SKU: 'TOTE-NAT', Price: '24.00' },
  );
  const item = available(
    await read('InventoryItem', gid('InventoryItem', '11')),
  );
  assert.equal(item.item[0].fields.SKU, 'TOTE-NAT');
  assert.deepEqual(
    item.levels.map((row) => [
      row.fields.Location,
      row.fields.incoming,
      row.fields.reserved,
    ]),
    [
      ['Hamburg Hub', 0, 0],
      ['Vienna Depot', 0, 0],
    ],
  );
  const work = available(
    await read('FulfillmentOrder', await ids.work(ids.held.id)),
  );
  assert.match(
    work.fulfillment[0].fields.Holds,
    /^INCORRECT_ADDRESS \(gid:\/\/shopify\/FulfillmentHold\/\d+\)$/,
  );
  assert.equal(work.fulfillment[0].fields.Request, 'UNSUBMITTED');
  const returnId = (await shop.store.page({ kind: 'Return', limit: 1 }))
    .items[0].id;
  const returned = available(await read('Return', gid('Return', returnId)));
  assert.deepEqual(returned.lines[0].fields, {
    Quantity: 1,
    Reason: 'Too small',
    'Order line': gid('LineItem', ids.returned.lines[0].id),
  });
  const refundId = (
    await shop.store.page({ kind: 'Refund', parent: ids.returned.id, limit: 1 })
  ).items[0].id;
  assert.equal(
    available(await read('Refund', gid('Refund', refundId))).refund[0].fields
      .Refunded,
    '0.0 EUR',
  );
});
