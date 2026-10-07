import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createInstallationVerifier, createJtlConnector } from '@luma/app-jtl';
import { createCapabilityRuntime } from '@luma/connections/adapters';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';

import {
  createMemoryStore,
  createTransport,
} from '../../packages/simulator/core/dist/index.js';
import { jtl } from '../../packages/simulator/jtl/dist/index.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const connectionId = 'jtl-contract';
const start = Date.parse('2026-10-01T08:00:00Z');
const observedAt = new Date(start + 3600000).toISOString();
const iso = (time) => new Date(time).toISOString();
const ref = (externalId, scopeKey = '') => ({ externalId, scopeKey });
const each = (amount) => ({ amount, unit: 'each' });

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
  warehouses: [
    { id: '1', name: 'Hamburg' },
    { id: '2', name: 'Leipzig' },
  ],
  shippingMethods: [
    { id: '7', name: 'Standard' },
    { id: '8', name: 'Express' },
    { id: '9', name: 'Pickup' },
  ],
};

const catalog = {
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
    {
      id: '2',
      companyName: 'Baltic Packaging AB',
      supplierNumber: 'L-1002',
      city: 'Malmö',
      countryIso: 'SE',
      email: 'purchasing@baltic-packaging.example',
      profile: 'partial',
    },
  ],
  items: [
    {
      id: '1',
      sku: 'LUMA-001',
      name: 'Canvas tote',
      price: '24.00',
      gtin: '4006381333931',
      manufacturer: 'Luma Goods',
      active: true,
      shopActive: true,
      stock: { 1: 100, 2: 20 },
      suppliers: [
        { supplierId: '1', netPrice: 9.5, isDefault: true },
        { supplierId: '2', netPrice: 10.2, isDefault: false },
      ],
    },
    {
      id: '2',
      sku: 'LUMA-002',
      name: 'Linen shirt',
      price: '59.90',
      gtin: null,
      manufacturer: 'Nordwind',
      active: true,
      shopActive: false,
      stock: { 1: 5 },
      suppliers: [{ supplierId: '1', netPrice: 21, isDefault: true }],
    },
    {
      id: '3',
      sku: 'LUMA-003',
      name: 'Archived mug',
      price: '9.00',
      gtin: null,
      manufacturer: 'Luma Goods',
      active: false,
      shopActive: false,
      stock: {},
      suppliers: [],
    },
  ],
};

/**
 * Seeds a JTL instance with three orders: order 1 shipped in two delivery notes from different
 * warehouses, order 2 open and order 3 cancelled.
 */
async function createEnvironment() {
  const store = createMemoryStore();
  const events = [];
  const requests = [];
  const clock = { now: start };
  const context = () => ({
    store,
    now: clock.now,
    wallTime: start,
    instance: 'jtl',
    config,
    indexLagMs: 0,
    notify: (event) => events.push(event),
  });
  const command = (value) => jtl.command(context(), value);

  await command(catalog);
  const order = (lines, externalNumber, paid = true) =>
    command({
      kind: 'order',
      externalNumber,
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
  const ship = (warehouse, tracking, lines) =>
    command({
      kind: 'ship',
      id: '1',
      warehouse,
      ...(lines ? { lines } : {}),
      trackingNumber: tracking,
      trackingUrl: `https://tracking.example.test/${tracking}`,
    });
  clock.now = start + 1000;
  await ship('2', 'JJD1', [{ lineId: '1', quantity: 1 }]);
  clock.now = start + 2000;
  await ship('1', 'JJD2');

  let observation = 0;
  const connector = createJtlConnector({
    tenantId,
    connectionId,
    connection: {
      kind: 'onprem',
      baseUrl: 'https://jtl.synthetic.invalid/api/eazybusiness/',
      appId: 'LumaContract',
      appVersion: '1',
      challengeCode: 'synthetic',
      apiKey: async () => 'synthetic-only',
    },
    fetch: createTransport(async (request) => {
      const response = await jtl.handle(context(), request);
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname.replace('/api/eazybusiness/', ''),
        status: response.status,
        committed: response.committed === true,
      });

      return response;
    }),
    recordObservations: async () => {},
    shippingMethodActions: true,
    purchaseOrderActions: true,
    now: () => new Date(observedAt),
    id: () =>
      `00000000-0000-4000-8000-${String(++observation).padStart(12, '0')}`,
  });
  const runtime = createCapabilityRuntime({
    resolve: async () => connector,
    record: async () => {},
  });

  return {
    clock,
    command,
    context,
    events,
    requests,
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
    write(capability, input, idempotencyKey) {
      return runtime.write(tenant, {
        connectionId,
        capability,
        version: '0',
        input,
        idempotencyKey,
      });
    },
    async modified(itemId) {
      const response = await jtl.handle(context(), {
        url: `https://jtl.synthetic.invalid/api/eazybusiness/items/${itemId}`,
        method: 'GET',
        headers: {
          authorization: 'Wawi synthetic',
          'x-appid': 'LumaContract',
          'x-appversion': '1',
        },
        body: null,
      });

      return response.body.modifiedTimestamp;
    },
  };
}

/** Removes generated observation IDs after checking them, and checks shared provenance. */
function observations(page, resource) {
  const ids = page.items.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);

  return page.items.map(({ id, source, adapterVersion, ...rest }) => {
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.match(adapterVersion, /^jtl\//);
    const { externalId, scopeKey, ...provenance } = source;
    assert.deepEqual(provenance, {
      tenantId,
      connectionId,
      provider: 'jtl',
      resource,
    });
    assert.equal(rest.observedAt, observedAt);
    assert.equal(rest.kind, 'snapshot');
    assert.equal(rest.schemaVersion, 1);
    assert.equal(rest.sourceRevision, null);

    return {
      source: ref(externalId, scopeKey),
      sourceUpdatedAt: rest.sourceUpdatedAt,
      data: rest.data,
    };
  });
}

const orderLine = (id, order, sku, quantity, code, title) => ({
  id: ref(id, order),
  sku: ref(sku),
  quantity: each(quantity),
  cancelledQuantity: null,
  skuCode: code,
  title,
});

test('orders.read pages sales orders with lines, totals and statuses', async () => {
  const jtlEnv = await createEnvironment();
  const first = await jtlEnv.read('orders.read', { limit: 2 });
  assert.equal(first.total, 3);
  assert.equal(first.completeness, 'complete');
  assert.ok(first.nextCursor);
  assert.deepEqual(observations(first, 'order'), [
    {
      source: ref('1'),
      sourceUpdatedAt: null,
      data: {
        displayNumber: 'AU-000001',
        externalOrderNumber: '#1001',
        placedAt: iso(start),
        total: { amount: '131.9', currency: 'EUR' },
        status: 'completed',
        paymentStatus: 'paid',
        lines: [
          orderLine('1', '1', '1', '3', 'LUMA-001', 'Canvas tote'),
          orderLine('2', '1', '2', '1', 'LUMA-002', 'Linen shirt'),
        ],
      },
    },
    {
      source: ref('2'),
      sourceUpdatedAt: null,
      data: {
        displayNumber: 'AU-000002',
        externalOrderNumber: '#1002',
        placedAt: iso(start),
        total: { amount: '48', currency: 'EUR' },
        status: 'open',
        paymentStatus: 'pending',
        lines: [orderLine('3', '2', '1', '2', 'LUMA-001', 'Canvas tote')],
      },
    },
  ]);
  const second = await jtlEnv.read('orders.read', {
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.equal(second.nextCursor, null);
  assert.deepEqual(
    observations(second, 'order').map(({ source, data }) => [
      source.externalId,
      data.status,
    ]),
    [['3', 'cancelled']],
  );
});

test('products.read reports catalog facts with the stock modification time', async () => {
  const jtlEnv = await createEnvironment();
  const page = await jtlEnv.read('products.read', { limit: 100 });
  assert.equal(page.total, 3);
  assert.equal(page.nextCursor, null);
  assert.deepEqual(observations(page, 'product'), [
    {
      source: ref('1'),
      sourceUpdatedAt: await jtlEnv.modified('1'),
      data: {
        title: 'Canvas tote',
        status: 'active',
        vendor: 'Luma Goods',
        published: true,
        skus: [
          {
            id: ref('1'),
            code: 'LUMA-001',
            unit: 'each',
            title: null,
            price: { amount: '24', currency: null },
            barcode: '4006381333931',
          },
        ],
      },
    },
    {
      source: ref('2'),
      sourceUpdatedAt: await jtlEnv.modified('2'),
      data: {
        title: 'Linen shirt',
        status: 'active',
        vendor: 'Nordwind',
        published: false,
        skus: [
          {
            id: ref('2'),
            code: 'LUMA-002',
            unit: 'each',
            title: null,
            price: { amount: '59.9', currency: null },
            barcode: null,
          },
        ],
      },
    },
    {
      source: ref('3'),
      sourceUpdatedAt: iso(start),
      data: {
        title: 'Archived mug',
        status: 'archived',
        vendor: 'Luma Goods',
        published: false,
        skus: [
          {
            id: ref('3'),
            code: 'LUMA-003',
            unit: 'each',
            title: null,
            price: { amount: '9', currency: null },
            barcode: null,
          },
        ],
      },
    },
  ]);
  assert.equal(await jtlEnv.modified('1'), iso(start + 2000));
});

test('inventory.read reports totals across warehouses and physical stock per warehouse', async () => {
  const jtlEnv = await createEnvironment();
  const all = await jtlEnv.read('inventory.read', { limit: 100 });
  const sku = (id, location, onHand, reserved, available) => ({
    source: ref(id, location),
    sourceUpdatedAt: null,
    data: {
      sku: ref(id),
      location: ref(location),
      unit: 'each',
      onHand,
      reserved,
      available,
      availabilityBasis: available === null ? 'unknown' : 'provider_reported',
    },
  });
  const withTimes = async (expected) =>
    Promise.all(
      expected.map(async (value) => ({
        ...value,
        sourceUpdatedAt: await jtlEnv.modified(value.source.externalId),
      })),
    );
  assert.deepEqual(
    observations(all, 'sku'),
    await withTimes([
      sku('1', 'all-warehouses', '117', '2', '115'),
      sku('2', 'all-warehouses', '4', '0', '4'),
      sku('3', 'all-warehouses', '0', '0', '0'),
    ]),
  );
  const leipzig = await jtlEnv.read('inventory.read', {
    limit: 100,
    location: ref('2'),
  });
  assert.deepEqual(
    observations(leipzig, 'sku'),
    await withTimes([
      sku('1', '2', '19', null, null),
      sku('2', '2', '0', null, null),
      sku('3', '2', '0', null, null),
    ]),
  );
  const shirt = await jtlEnv.read('inventory.read', {
    limit: 100,
    sku: ref('2'),
    location: ref('1'),
  });
  assert.deepEqual(
    observations(shirt, 'sku'),
    await withTimes([sku('2', '1', '4', null, null)]),
  );
  assert.equal(
    jtlEnv.requests.filter((r) => r.path.endsWith('/stocks')).length,
    4,
  );
});

test('fulfillment.read reports each partial shipment of an order', async () => {
  const jtlEnv = await createEnvironment();
  const shipment = (id, at, lines, tracking) => ({
    source: ref(id),
    sourceUpdatedAt: null,
    data: {
      order: ref('1'),
      status: 'shipped',
      lines: lines.map(([line, amount]) => ({
        orderLine: ref(line, '1'),
        quantity: each(amount),
      })),
      lastProgressAt: iso(at),
      progressBasis: 'note_created_or_package_shipped',
      failureCode: null,
      kind: 'shipment',
      tracking: [
        {
          carrier: null,
          number: tracking,
          url: `https://tracking.example.test/${tracking}`,
        },
      ],
    },
  });
  const all = await jtlEnv.read('fulfillment.read', { limit: 100 });
  assert.equal(all.nextCursor, null);
  assert.deepEqual(observations(all, 'fulfillment'), [
    shipment('1', start + 1000, [['1', '1']], 'JJD1'),
    shipment(
      '2',
      start + 2000,
      [
        ['1', '2'],
        ['2', '1'],
      ],
      'JJD2',
    ),
  ]);
  const first = await jtlEnv.read('fulfillment.read', {
    limit: 1,
    order: ref('1'),
  });
  const second = await jtlEnv.read('fulfillment.read', {
    limit: 1,
    order: ref('1'),
    cursor: first.nextCursor,
  });
  assert.equal(second.nextCursor, null);
  assert.deepEqual(
    [...first.items, ...second.items].map((item) => item.source.externalId),
    ['1', '2'],
  );
  const none = await jtlEnv.read('fulfillment.read', {
    limit: 10,
    order: ref('2'),
  });
  assert.deepEqual(none.items, []);
});

test('orders.shipping-method read and write follow the order state without CAS', async () => {
  const jtlEnv = await createEnvironment();
  const state = async (order) => {
    const page = await jtlEnv.read('orders.shipping-method.read', {
      order: ref(order),
      limit: 1,
    });
    assert.equal(page.nextCursor, null);

    return observations(page, 'order')[0].data;
  };
  assert.deepEqual(await state('2'), {
    shippingMethod: ref('7'),
    isCancelled: false,
    orderStatus: 'open',
  });
  assert.deepEqual(await state('1'), {
    shippingMethod: ref('7'),
    isCancelled: false,
    orderStatus: 'shipped',
  });
  assert.deepEqual(await state('3'), {
    shippingMethod: ref('7'),
    isCancelled: true,
    orderStatus: 'cancelled',
  });
  const change = (order, expected, next, key) =>
    jtlEnv.write(
      'orders.shipping-method.write',
      {
        order: ref(order),
        expectedShippingMethod: ref(expected),
        shippingMethod: ref(next),
      },
      key,
    );
  const accepted = await change('2', '7', '8', 'change-1');
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.value.status, 'accepted');
  assert.deepEqual(await state('2'), {
    shippingMethod: ref('8'),
    isCancelled: false,
    orderStatus: 'open',
  });
  assert.deepEqual(
    jtlEnv.events
      .filter((e) => e.topic === 'sales-orders/update' && e.resource === '2')
      .map((e) => e.payload),
    [{ salesOrderId: '2', deliveryStatus: 1, isCancelled: false }],
  );
  for (const [order, expected] of [
    ['2', '7'],
    ['3', '7'],
    ['1', '7'],
  ]) {
    const refused = await change(order, expected, '9', `refused-${order}`);
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'conflict');
  }
  const patches = jtlEnv.requests.filter((r) => r.method === 'PATCH');
  assert.deepEqual(patches, [
    { method: 'PATCH', path: 'sales-orders/2', status: 200, committed: true },
  ]);
  // A merchant change between preflight and PATCH is overwritten; JTL offers no CAS.
  await jtlEnv.command({
    kind: 'shipping-method',
    id: '2',
    shippingMethodId: '9',
  });
  assert.equal((await state('2')).shippingMethod.externalId, '9');
});

test('suppliers.read lists active suppliers and reads supplier contacts', async () => {
  const jtlEnv = await createEnvironment();
  const first = await jtlEnv.read('suppliers.read', { limit: 1 });
  assert.equal(first.total, 2);
  assert.deepEqual(observations(first, 'supplier'), [
    {
      source: ref('1'),
      sourceUpdatedAt: null,
      data: {
        name: 'Nordwind Textil GmbH',
        number: 'L-1001',
        active: true,
        email: null,
      },
    },
  ]);
  const second = await jtlEnv.read('suppliers.read', {
    limit: 1,
    cursor: first.nextCursor,
  });
  assert.equal(second.nextCursor, null);
  assert.equal(second.items[0].source.externalId, '2');
  const detail = await jtlEnv.read('suppliers.read', {
    limit: 1,
    supplier: ref('2'),
  });
  assert.deepEqual(observations(detail, 'supplier')[0].data, {
    name: 'Baltic Packaging AB',
    number: 'L-1002',
    active: true,
    email: 'purchasing@baltic-packaging.example',
  });
});

test('purchase-orders submit once per provider key and read through receipt', async () => {
  const jtlEnv = await createEnvironment();
  const submission = (lumaOrderId) => ({
    lumaOrderId,
    reference: 'Replenishment PO-7',
    supplier: ref('1'),
    requestedDeliveryDate: '2026-10-12',
    lines: [
      { sku: ref('1'), quantity: each('10') },
      { sku: ref('2'), quantity: each('4') },
    ],
  });
  const submitted = await jtlEnv.write(
    'purchase-orders.submit',
    submission('po-7'),
    'submit-1',
  );
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  assert.equal(submitted.value.status, 'accepted');
  assert.equal(submitted.value.evidenceRefs.length, 1);
  const created = jtlEnv.events.filter(
    (e) => e.topic === 'purchase-orders/create',
  );
  assert.equal(created.length, 1);
  assert.equal(created[0].resource, '1');
  assert.deepEqual(
    created[0].payload.supplierEvents.map((e) => [e.delay, e.command.kind]),
    [
      [20000, 'purchase-order-confirm'],
      [60000, 'purchase-order-receive'],
    ],
  );

  // The same provider key replays the recorded order instead of creating another.
  const replayed = await jtlEnv.write(
    'purchase-orders.submit',
    submission('po-8'),
    'submit-1',
  );
  assert.equal(replayed.ok, true, JSON.stringify(replayed));
  assert.deepEqual(replayed.value.evidenceRefs, submitted.value.evidenceRefs);
  // A new key for an order JTL already holds is refused before dispatch.
  const duplicate = await jtlEnv.write(
    'purchase-orders.submit',
    submission('po-7'),
    'submit-2',
  );
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error.code, 'conflict');
  assert.deepEqual(
    jtlEnv.requests.filter((r) => r.method === 'POST'),
    [
      { method: 'POST', path: 'purchase-orders', status: 201, committed: true },
      {
        method: 'POST',
        path: 'purchase-orders',
        status: 201,
        committed: false,
      },
    ],
  );

  const line = (id, sku, code, quantity, delivered, confirmed) => ({
    id: ref(id, '1'),
    sku: ref(sku),
    itemNumber: code,
    quantity: each(quantity),
    deliveredQuantity: delivered,
    confirmedQuantity: confirmed,
    confirmedDeliveryDate: confirmed === null ? null : '2026-10-12',
    confirmed: confirmed === null ? null : true,
    requestedDeliveryDate: '2026-10-12',
  });
  const order = (status, confirmed, lines) => ({
    source: ref('1'),
    sourceUpdatedAt: null,
    data: {
      supplier: ref('1'),
      orderNumber: 'BE-00001',
      lumaOrderId: 'po-7',
      status,
      requestedDeliveryDate: '2026-10-12',
      confirmed,
      createdAt: iso(start + 2000),
      lines,
    },
  });
  const listed = await jtlEnv.read('purchase-orders.read', { limit: 25 });
  assert.equal(listed.total, 1);
  assert.deepEqual(observations(listed, 'purchase_order'), [
    order('open', false, [
      line('1001', '1', 'LUMA-001', '10', '0', null),
      line('1002', '2', 'LUMA-002', '4', '0', null),
    ]),
  ]);

  for (const { command } of created[0].payload.supplierEvents) {
    jtlEnv.clock.now += 30000;
    await jtlEnv.command(command);
  }
  const received = order('completed', true, [
    line('1001', '1', 'LUMA-001', '10', '10', '10'),
    line('1002', '2', 'LUMA-002', '4', '4', '4'),
  ]);
  const byId = await jtlEnv.read('purchase-orders.read', {
    limit: 1,
    order: ref('1'),
  });
  assert.deepEqual(observations(byId, 'purchase_order'), [received]);
  const byMarker = await jtlEnv.read('purchase-orders.read', {
    limit: 25,
    created: { lumaOrderId: 'po-7', createdSince: iso(start) },
  });
  assert.equal(byMarker.completeness, 'complete');
  assert.deepEqual(observations(byMarker, 'purchase_order'), [received]);

  const stock = await jtlEnv.read('inventory.read', {
    limit: 100,
    sku: ref('1'),
    location: ref('1'),
  });
  assert.equal(stock.items[0].data.onHand, '108');
});

test('installation verification grants every probed read through the simulation transport', async () => {
  const jtlEnv = await createEnvironment();
  const transport = createTransport((request) =>
    jtl.handle(jtlEnv.context(), request),
  );
  const verify = createInstallationVerifier({
    simulation: () => transport,
    jtlEndpoints: [],
  });
  const granted = await verify(
    {
      id: connectionId,
      tenantId,
      label: 'SIMULATED JTL',
      target: {
        kind: 'jtl-cloud',
        jtlTenantId: '6a1c1d2e-0d3c-4a43-9b6e-6f4d3c2b1a00',
      },
      permissions: [
        'orders.read',
        'products.read',
        'inventory.read',
        'fulfillment.read',
        'suppliers.read',
        'purchase-orders.read',
        'purchase-orders.submit',
      ],
      granted: [],
      status: 'pending',
      version: 1,
      credentialVersion: 1,
      createdAt: iso(start),
      updatedAt: iso(start),
    },
    { token: 'synthetic-only' },
  );
  assert.deepEqual(granted, [
    'orders.read',
    'products.read',
    'inventory.read',
    'fulfillment.read',
    'suppliers.read',
    'purchase-orders.read',
    'orders.shipping-method.read',
    'orders.shipping-method.write',
    'purchase-orders.submit',
  ]);
});
