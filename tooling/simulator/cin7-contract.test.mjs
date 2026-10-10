import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createCin7Connector,
  createInstallationVerifier,
} from '@luma/app-cin7';
import { createCapabilityRuntime } from '@luma/connections/adapters';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';

import { createRequestPacer } from '../../packages/connectors/cin7/dist/index.js';
import {
  createCin7Simulator,
  guid,
  simulatedAccountId,
} from '../../packages/simulator/cin7/dist/index.js';
import {
  createMemoryStore,
  createTransport,
} from '../../packages/simulator/core/dist/index.js';
import { jtl, kinds } from '../../packages/simulator/jtl/dist/index.js';

// The account runs the JTL ERP model, as in the simulator host.
const cin7 = createCin7Simulator({
  kinds,
  command: (context, command) => jtl.command(context, command),
});

const tenantId = '00000000-0000-4000-8000-000000000001';
const connectionId = 'cin7-contract';
const accountId = simulatedAccountId;
const start = Date.parse('2026-10-01T08:00:00Z');
const observedAt = new Date(start + 3600000).toISOString();
const ref = (externalId, scopeKey = '') => ({ externalId, scopeKey });
const each = (amount) => ({ amount, unit: 'each' });
const [tote, shirt, mug] = ['1', '2', '3'].map((id) => guid('product', id));
const [hamburg, leipzig] = ['1', '2'].map((id) => guid('location', id));

const tenant = makeTenantContext(
  { userId: 'owner', sessionId: 'session' },
  {
    id: tenantId,
    name: 'Test',
    slug: 'test',
    status: 'active',
    dataRegion: 'EU',
  },
  builtInMembership(
    { id: 'member', organizationId: tenantId, userId: 'owner' },
    'owner',
  ),
  'request',
);

const config = {
  accountId,
  company: 'Luma Goods GmbH',
  warehouses: [
    { id: '1', name: 'Hamburg' },
    { id: '2', name: 'Leipzig' },
  ],
  shippingMethods: [{ id: '7', name: 'DHL Paket' }],
};

const item = (id, sku, name, stock, active = true) => ({
  id,
  sku,
  name,
  price: '24.00',
  gtin: null,
  manufacturer: 'Luma Goods',
  active,
  shopActive: true,
  stock,
  suppliers: [{ supplierId: '1', netPrice: 9.5, isDefault: true }],
});

/**
 * Seeds a Cin7 account with three sales: sale 1 shipped from both locations, sale 2 open and
 * unpaid for a returning customer, sale 3 voided. One purchase order is partly received.
 */
async function createEnvironment() {
  const store = createMemoryStore();
  const clock = { now: start };
  const context = () => ({
    store,
    now: clock.now,
    wallTime: start,
    instance: 'cin7',
    config,
    indexLagMs: 0,
    notify: () => {},
  });
  const command = (value) => cin7.command(context(), value);
  await command({
    kind: 'seed-catalog',
    suppliers: [
      {
        id: '1',
        companyName: 'Nordwind Textil GmbH',
        supplierNumber: 'L-1001',
        city: 'Hamburg',
        countryIso: 'DE',
        email: 'orders@nordwind-textil.example',
        profile: 'full',
      },
    ],
    items: [
      item('1', 'LUMA-001', 'Canvas tote', { 1: 100, 2: 20 }),
      item('2', 'LUMA-002', 'Linen shirt', { 1: 5 }),
      item('3', 'LUMA-003', 'Archived mug', {}, false),
    ],
  });
  const customer = {
    email: 'ada@example.test',
    firstName: 'Ada',
    lastName: 'Lovelace',
    street: 'Hafenstraße 1',
    city: 'Hamburg',
    postalCode: '20095',
    countryIso: 'DE',
  };
  const order = (lines, externalNumber, paid = true) =>
    command({
      kind: 'order',
      externalNumber,
      customer,
      lines,
      shippingMethodId: '7',
      currency: 'EUR',
      paid,
    });
  await order(
    [
      { itemId: '1', quantity: 3, price: 24 },
      { itemId: '2', quantity: 1, price: 59.9 },
    ],
    '#1001',
  );
  await order([{ itemId: '1', quantity: 2, price: 24 }], '#1002', false);
  await order([{ itemId: '1', quantity: 1, price: 24 }], '#1003');
  await command({ kind: 'cancel', id: '3' });
  clock.now = start + 1000;
  await command({
    kind: 'ship',
    id: '1',
    warehouse: '2',
    lines: [{ lineId: '1', quantity: 1 }],
    trackingNumber: 'JJD1',
    trackingUrl: 'https://tracking.example.test/JJD1',
  });
  clock.now = start + 2000;
  await command({
    kind: 'ship',
    id: '1',
    warehouse: '1',
    trackingNumber: 'JJD2',
    trackingUrl: 'https://tracking.example.test/JJD2',
  });
  const purchase = await command({
    kind: 'purchase-order',
    supplierId: '1',
    deliveryDate: '2026-10-08',
    lines: [
      { itemId: '1', quantity: 10 },
      { itemId: '2', quantity: 4 },
    ],
  });
  await command({
    kind: 'purchase-order-receive',
    orderId: purchase.id,
    lines: [{ lineItemId: purchase.lines[0].id, quantity: 6 }],
  });

  const fetch = createTransport((request) => cin7.handle(context(), request));
  let observation = 0;
  const connector = createCin7Connector({
    tenantId,
    connectionId,
    connection: { accountId, applicationKey: async () => 'synthetic-only' },
    fetch,
    pacer: createRequestPacer({ intervalMs: 0 }),
    customers: true,
    recordObservations: async () => {},
    now: () => new Date(observedAt),
    id: () =>
      `00000000-0000-4000-8000-${String(++observation).padStart(12, '0')}`,
  });
  const runtime = createCapabilityRuntime({
    resolve: async () => connector,
    record: async () => {},
  });

  return {
    fetch,
    purchase,
    async read(capability, input) {
      const result = await runtime.read(tenant, {
        connectionId,
        capability,
        version: '0',
        input,
      });
      assert.equal(result.ok, true, JSON.stringify(result));

      return result.value;
    },
  };
}

const data = (page) =>
  page.items.map((item) => ({
    id: item.source.externalId,
    scope: item.source.scopeKey,
    kind: item.kind,
    data: item.data,
  }));

test('the Cin7 adapter verifies and reads the simulated account', async () => {
  const environment = await createEnvironment();
  const verify = createInstallationVerifier({
    fetch: environment.fetch,
    pacer: () => createRequestPacer({ intervalMs: 0 }),
  });
  const permissions = [
    'orders.read',
    'fulfillment.read',
    'returns.read',
    'products.read',
    'inventory.read',
    'customers.read',
    'suppliers.read',
    'purchase-orders.read',
  ];
  assert.deepEqual(
    await verify(
      {
        id: connectionId,
        tenantId,
        label: 'Cin7',
        target: { kind: 'cin7-core', accountId },
        permissions,
        granted: [],
        status: 'pending',
        version: 1,
        credentialVersion: 1,
        createdAt: observedAt,
        updatedAt: observedAt,
      },
      { token: 'synthetic-only' },
    ),
    permissions,
  );

  const orders = data(await environment.read('orders.read', { limit: 100 }));
  assert.deepEqual(
    orders.map(({ data: order }) => [
      order.displayNumber,
      order.externalOrderNumber,
      order.status,
      order.paymentStatus,
    ]),
    [
      ['SO-00001', '#1001', 'completed', 'paid'],
      ['SO-00002', '#1002', 'open', 'pending'],
      ['SO-00003', '#1003', 'cancelled', 'paid'],
    ],
  );
  assert.deepEqual(orders[0].data.lines, [
    {
      id: ref(tote, orders[0].id),
      sku: ref(tote),
      quantity: each('3'),
      cancelledQuantity: null,
      skuCode: 'LUMA-001',
      title: 'Canvas tote',
    },
    {
      id: ref(shirt, orders[0].id),
      sku: ref(shirt),
      quantity: each('1'),
      cancelledQuantity: null,
      skuCode: 'LUMA-002',
      title: 'Linen shirt',
    },
  ]);
  assert.equal(
    orders[0].data.customer.externalId,
    orders[1].data.customer.externalId,
  );

  const fulfillments = data(
    await environment.read('fulfillment.read', { limit: 100 }),
  );
  assert.deepEqual(
    fulfillments.map(({ data: f }) => [
      f.status,
      f.location.id.externalId,
      f.lines.map((line) => [line.orderLine.externalId, line.quantity.amount]),
      f.tracking.map((entry) => [entry.carrier, entry.number]),
    ]),
    [
      ['shipped', leipzig, [[tote, '1']], [['DHL Paket', 'JJD1']]],
      [
        'shipped',
        hamburg,
        [
          [tote, '2'],
          [shirt, '1'],
        ],
        [['DHL Paket', 'JJD2']],
      ],
    ],
  );

  const returns = await environment.read('returns.read', { limit: 100 });
  assert.deepEqual(returns.items, []);

  const products = data(
    await environment.read('products.read', { limit: 100 }),
  );
  assert.deepEqual(
    products.map(({ id, data: product }) => [
      id,
      product.status,
      product.skus[0].unit,
    ]),
    [
      [tote, 'active', 'each'],
      [shirt, 'active', 'each'],
      [mug, 'archived', 'each'],
    ],
  );

  // Hamburg shipped two totes and received six; the open sale's two are allocated there.
  const stock = data(await environment.read('inventory.read', { limit: 100 }));
  const at = (sku, location) =>
    stock.find((row) => row.id === sku && row.scope === location)?.data;
  assert.deepEqual(at(tote, hamburg), {
    sku: ref(tote),
    location: ref(hamburg),
    unit: 'each',
    onHand: '104',
    reserved: '2',
    available: '102',
    availabilityBasis: 'provider_reported',
  });
  assert.equal(at(tote, leipzig).available, '19');
  assert.equal(at(shirt, hamburg).onHand, '4');

  const customers = data(
    await environment.read('customers.read', { limit: 100 }),
  );
  assert.equal(customers.length, 1);
  assert.equal(customers[0].data.email, 'ada@example.test');

  const suppliers = data(
    await environment.read('suppliers.read', { limit: 100 }),
  );
  assert.deepEqual(suppliers[0].data, {
    name: 'Nordwind Textil GmbH',
    number: null,
    active: true,
    email: 'orders@nordwind-textil.example',
  });

  const purchases = data(
    await environment.read('purchase-orders.read', { limit: 25 }),
  );
  assert.equal(purchases[0].data.status, 'partially_delivered');
  assert.deepEqual(
    purchases[0].data.lines.map((line) => [
      line.sku.externalId,
      line.quantity.amount,
      line.deliveredQuantity,
    ]),
    [
      [tote, '10', '6'],
      [shirt, '4', '0'],
    ],
  );
});

test('incremental reads see only sales changed since the filter', async () => {
  const environment = await createEnvironment();
  const page = await environment.read('orders.read', {
    limit: 100,
    updatedSince: new Date(start + 1500).toISOString(),
  });
  assert.deepEqual(
    page.items.map((item) => item.data.displayNumber),
    ['SO-00001'],
  );
});
