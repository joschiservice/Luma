import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createStarshipitConnector } from '@luma/app-starshipit';
import { createCapabilityRuntime } from '@luma/connections/adapters';
import { createClient } from '@luma/connector-starshipit';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';

import {
  createMemoryStore,
  createTransport,
} from '../../packages/simulator/core/dist/index.js';
import { starshipit } from '../../packages/simulator/starshipit/dist/index.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const connectionId = '00000000-0000-4000-8000-000000000002';
const start = Date.parse('2026-10-01T08:00:00Z');
const timestamp = new Date(start).toISOString();
const tenant = makeTenantContext(
  { userId: 'owner', sessionId: 'session' },
  {
    id: tenantId,
    name: 'Test',
    slug: 'test',
    status: 'active',
    dataRegion: globalThis.process.env.LUMA_REGION ?? 'AU',
  },
  builtInMembership(
    { id: 'member', organizationId: tenantId, userId: 'owner' },
    'owner',
  ),
  'request',
);

async function environment() {
  const store = createMemoryStore();
  const events = [];
  const context = {
    store,
    now: start,
    wallTime: start,
    instance: 'starshipit',
    config: { name: 'Synthetic account' },
    indexLagMs: 0,
    notify: (event) => events.push(event),
  };
  const command = (input) => starshipit.command(context, input);
  await command({
    kind: 'order',
    order: {
      order_id: 1,
      order_number: '#SIM-1',
      order_date: timestamp,
      last_updated_date: timestamp,
      status: 'Unshipped',
      destination: {},
      packages: [],
      items: [
        {
          item_id: 11,
          sku: 'LUMA-001',
          description: 'Tote',
          quantity: 3,
          weight: 0.2,
          value: 12,
        },
      ],
    },
  });
  let lost = false;
  let writes = 0;
  const fetch = createTransport(async (request) => {
    const response = await starshipit.handle(context, request);
    if (response.committed) writes++;

    return lost && response.committed ? { ...response, lost: true } : response;
  });
  const credentials = async () => ({
    token: 'synthetic-api-key',
    subscriptionKey: 'synthetic-subscription-key',
  });
  const connector = createStarshipitConnector({
    tenantId,
    connectionId,
    fetch,
    credentials,
    recordObservations: async () => {},
    now: () => new Date(context.now),
    readRetry: { attempts: 1, maxDelayMs: 0, sleep: async () => {} },
  });
  const runtime = createCapabilityRuntime({
    resolve: async () => connector,
    record: async () => {},
  });

  return {
    store,
    context,
    command,
    events,
    client: createClient({
      fetch,
      credentials,
      readRetry: { attempts: 1, maxDelayMs: 0, sleep: async () => {} },
    }),
    lose: () => {
      lost = true;
    },
    writes: () => writes,
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

const parcel = (id, quantity, status = 'In Transit') => ({
  package_id: id,
  tracking_number: `TRACK-${id}`,
  tracking_url: `https://tracking.example.test/${id}`,
  carrier: 'Synthetic Carrier',
  items: [{ item_id: 11, quantity }],
  status,
  shipment_date: timestamp,
  last_updated_date: timestamp,
  tracking_events: [{ status, description: status, event_date: timestamp }],
});

test('unchanged Starshipit adapter reads partial and split parcels without guessing shipment line quantities', async () => {
  const f = await environment();
  const initial = await f.read('fulfillment.read', {
    limit: 10,
    order: { externalId: '1', scopeKey: '' },
  });
  assert.equal(initial.items.length, 1);
  assert.equal(initial.items[0].data.shipping.stage, 'unknown');
  await f.command({ kind: 'ship', order: '1', parcel: parcel(1, 1) });
  const partial = await f.read('fulfillment.read', {
    limit: 10,
    order: { externalId: '1', scopeKey: '' },
  });
  assert.equal(partial.items.length, 2);
  assert.deepEqual(partial.items[1].data.lines, []);
  assert.equal(partial.items[1].data.status, 'shipped');
  await f.command({ kind: 'ship', order: '1', parcel: parcel(2, 2) });
  const split = await f.read('fulfillment.read', {
    limit: 10,
    order: { externalId: '1', scopeKey: '' },
  });
  assert.equal(split.items.length, 3);
  assert.deepEqual(
    split.items.slice(1).map((item) => item.data.tracking[0].number),
    ['TRACK-1', 'TRACK-2'],
  );
  await assert.rejects(
    f.command({ kind: 'ship', order: '1', parcel: parcel(3, 1) }),
    /remaining provider item quantity/,
  );
});

test('label creation stays distinct from carrier handoff and stale tracking keeps its original timestamp', async () => {
  const f = await environment();
  await f.command({
    kind: 'ship',
    order: '1',
    parcel: parcel(1, 1, 'Printed'),
  });
  await f.command({ kind: 'status', order: '1', status: 'Printed' });
  f.context.now += 3 * 86400000;
  const page = await f.read('fulfillment.read', {
    limit: 10,
    order: { externalId: '1', scopeKey: '' },
  });
  const shipment = page.items.find((item) => item.data.kind === 'shipment');
  assert.equal(shipment.data.delivery, 'label_created');
  assert.equal(shipment.data.status, 'processing');
  assert.equal(shipment.data.milestones.shippedAt, null);
  assert.equal(shipment.data.shipping.stage, 'unknown');
  assert.equal(shipment.sourceUpdatedAt, timestamp);
  assert.notEqual(shipment.sourceUpdatedAt, shipment.observedAt);
});

test('duplicate and reordered notifications preserve corrected parcel tracking evidence and identity', async () => {
  const f = await environment();
  await f.command({ kind: 'ship', order: '1', parcel: parcel(1, 1) });
  await f.command({
    kind: 'tracking',
    order: '1',
    package: 1,
    status: 'Delivered',
    tracking_url: 'https://tracking.example.test/corrected',
    carrier: 'Corrected Carrier',
  });
  const before = await f.store.get('order', '1');
  await f.command({
    kind: 'webhook',
    order: '1',
    copies: 2,
    updatedAt: '2026-09-01T00:00:00Z',
  });
  assert.deepEqual(await f.store.get('order', '1'), before);
  assert.equal(
    f.events.at(-1).payload.last_updated_date,
    '2026-09-01T00:00:00Z',
  );
  assert.deepEqual(f.events.at(-1), f.events.at(-2));
  const page = await f.read('fulfillment.read', {
    limit: 10,
    order: { externalId: '1', scopeKey: '' },
  });
  assert.equal(
    page.items.find((item) => item.data.kind === 'shipment').data.status,
    'delivered',
  );
  const tracking = page.items.find((item) => item.data.kind === 'shipment').data
    .tracking[0];
  assert.equal(tracking.number, 'TRACK-1');
  assert.equal(tracking.url, 'https://tracking.example.test/corrected');
  assert.equal(tracking.carrier, 'Corrected Carrier');
});

test('an update that commits and loses its response is uncertain and never retried by the real client', async () => {
  const f = await environment();
  const original = (await f.store.get('order', '1')).data;
  f.lose();
  await assert.rejects(
    f.client.update({
      order_id: 1,
      items: original.items.map((item) => ({ ...item, quantity: 2 })),
    }),
    (error) =>
      error.failure.effect === 'unknown' && error.failure.retry === 'never',
  );
  assert.equal(f.writes(), 1);
  const current = await f.read('orders.read', {
    limit: 10,
    order: { externalId: '1', scopeKey: '' },
  });
  assert.equal(current.items[0].data.lines[0].currentQuantity.amount, '2');
});

test('scan pagination crosses all documented order states and preserves independent provider identities', async () => {
  const f = await environment();
  await f.command({
    kind: 'order',
    order: {
      ...(await f.store.get('order', '1')).data,
      order_id: 2,
      order_number: '#SIM-2',
      status: 'Printed',
    },
  });
  await f.command({
    kind: 'order',
    order: {
      ...(await f.store.get('order', '1')).data,
      order_id: 3,
      order_number: '#SIM-3',
      status: 'Shipped',
    },
  });
  const identities = [];
  let cursor;
  do {
    const page = await f.read('orders.read', {
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    identities.push(...page.items.map((item) => item.source.externalId));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(identities, ['1', '2', '3']);
});
