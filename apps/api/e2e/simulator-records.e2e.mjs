import { expect, test } from 'vitest';

import { until } from './helpers.mjs';
import { setupSimulator } from './simulator-fixture.mjs';

/** Signs in as the pilot operator on the in-process pilot API. */
async function operatorCookie(f) {
  const response = await f.pilot.app.inject({
    method: 'POST',
    url: '/auth/sign-in/email',
    headers: { origin: 'http://127.0.0.1:3000' },
    payload: { email: 'pilot-operator@example.test', password: f.password },
  });
  expect(response.statusCode).toBe(200);

  return response.cookies
    .map(({ name, value }) => `${name}=${value}`)
    .join('; ');
}

test('imports JTL customers with their orders and flags a customer deleted in JTL', async (t) => {
  const f = await setupSimulator(t);
  const base = `/v1/organizations/${f.manifest.organizationId}`;
  const cookie = await operatorCookie(f);
  const jtl = f.manifest.connections.jtl;
  const api = async (url, options = {}) => {
    const response = await f.pilot.app.inject({
      url: `${base}${url}`,
      headers: { cookie, origin: 'http://127.0.0.1:3000' },
      ...options,
    });
    expect(response.statusCode).toBe(200);

    return response.json();
  };
  const customers = async () =>
    (await api(`/customers?connectionId=${jtl}`)).items;
  await f.pilot.observe();
  // The order integration carries each fixture order's shop customer into JTL.
  const [buyer] = await customers();
  expect(buyer).toMatchObject({ missingSince: null });
  expect(buyer.email).toMatch(/@/);
  const history = await api(`/orders?customerId=${buyer.id}`);
  expect(history.items.length).toBeGreaterThan(0);
  expect(
    history.items.every((order) =>
      order.sources.some((source) => source.connectionId === jtl),
    ),
  ).toBe(true);

  await f.call('runs/operations/control', {
    action: 'command',
    instance: 'jtl',
    command: { kind: 'delete-customer', id: buyer.externalId },
  });
  const stream = (await api('/sync')).connections
    .find((item) => item.connectionId === jtl)
    .recordTypes.find((item) => item.recordType === 'customers').stream;
  await api(`/sync/${stream.id}/commands`, {
    method: 'POST',
    payload: { command: 'reconcile' },
  });
  await f.pilot.observe({ refresh: false });
  // One full read without the customer flags them; the profile and its history stay.
  const flagged = (await customers()).find((item) => item.id === buyer.id);
  expect(flagged.missingSince).not.toBeNull();
  expect((await api(`/orders?customerId=${buyer.id}`)).items).toHaveLength(
    history.items.length,
  );
});

test('signed Shopify webhooks reach the real change route and schedule early reads', async (t) => {
  const f = await setupSimulator(t, { imported: true });
  await f.pilot.observe();
  const hints = async () =>
    (
      await f.db.owner.query(
        'SELECT capabilities FROM connector_refresh_hints WHERE connection_id=$1 ORDER BY received_at',
        [f.manifest.connections.shopify],
      )
    ).rows;
  const already = (await hints()).length;
  await f.call('runs/operations/control', {
    action: 'order',
    lines: [{ sku: 'LUMA-001', quantity: 1 }],
  });
  // The order and its stock change arrive as separate webhooks, in either order.
  await until(
    async () =>
      (await hints())
        .slice(already)
        .some((row) => row.capabilities.includes('orders.read')),
    'order webhook stored a refresh hint',
    20_000,
  );
});

test('stuck-fulfillment candidates carry the source references their import mapped', async (t) => {
  const f = await setupSimulator(t, { imported: true });
  const actor = await f.pilot.operator();
  await f.call('runs/operations/control', {
    action: 'order',
    lines: [{ sku: 'LUMA-001', quantity: 2 }],
  });
  await f.pilot.observe({ check: false });
  const later = new Date(Date.now() + 86_400_000).toISOString();
  const open = await f.pilot.detectionSources.fulfillments(actor, {
    before: later,
    include: [],
    limit: 50,
  });
  expect(open.length).toBeGreaterThan(0);
  // Shipping work remains visible, but an observation time cannot establish progress.
  const unknownShipping = await f.db.owner.query(
    'SELECT entity_id,last_progress_at FROM orders_fulfillment_list WHERE tenant_id=$1 AND connection_id=$2 AND open',
    [f.manifest.organizationId, f.manifest.connections.starshipit],
  );
  expect(unknownShipping.rows.length).toBeGreaterThan(0);
  expect(
    unknownShipping.rows.every((row) => row.last_progress_at === null),
  ).toBe(true);
  expect(
    open.some(
      (work) => work.connectionId === f.manifest.connections.starshipit,
    ),
  ).toBe(false);
  const persistedShipping = unknownShipping.rows[0];
  expect(
    await f.pilot.detectionSources.fulfillments(actor, {
      before: new Date(Date.now() - 86_400_000).toISOString(),
      include: [
        {
          fulfillmentId: persistedShipping.entity_id,
          connectionId: f.manifest.connections.starshipit,
        },
      ],
      limit: 50,
    }),
  ).toEqual([
    expect.objectContaining({
      fulfillmentId: persistedShipping.entity_id,
      connectionId: f.manifest.connections.starshipit,
    }),
  ]);
  for (const work of open) {
    expect(work.connectionId).toBe(f.manifest.connections.shopify);
    expect(work.source).toMatchObject({
      resource: 'fulfillment',
      connectionId: work.connectionId,
    });
    expect(work.order.externalId).toMatch(/^gid:\/\/shopify\/Order\//);
    expect(work.lines.length).toBeGreaterThan(0);
  }
  // Work that progressed recently is not a candidate yet.
  expect(
    await f.pilot.detectionSources.fulfillments(actor, {
      before: new Date(Date.now() - 86_400_000).toISOString(),
      include: [],
      limit: 50,
    }),
  ).toEqual([]);
});

test('reads simulated quantity edits into new immutable snapshots and exposes current units in order detail', async (t) => {
  const f = await setupSimulator(t, { imported: true });
  const connectionId = f.manifest.connections.shopify;
  const tenantId = f.manifest.organizationId;
  const cookie = await operatorCookie(f);
  await f.pilot.observe();
  const mapped = await f.db.owner.query(
    "SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource='order' AND external_id='gid://shopify/Order/1'",
    [tenantId, connectionId],
  );
  const orderId = mapped.rows[0].canonical_id;
  const detail = async () => {
    const response = await f.pilot.app.inject({
      method: 'GET',
      url: `/v1/organizations/${tenantId}/orders/${orderId}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);

    return response.json();
  };
  const original = await f.db.owner.query(
    'SELECT s.id,s.document FROM orders_projections p JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id WHERE p.tenant_id=$1 AND p.entity_id=$2 AND p.connection_id=$3',
    [tenantId, orderId, connectionId],
  );
  const before = original.rows[0];
  expect(
    (await detail()).sources.find(
      (source) => source.connectionId === connectionId,
    ).lines[0],
  ).toMatchObject({
    quantity: '2',
    currentQuantity: '2',
    cancelledQuantity: '0',
  });
  const provider = await f.call(
    'runs/operations/records/shopify?kind=LineItem&parent=1',
  );
  const lineId = provider.items[0].id;
  const hints = async () =>
    (
      await f.db.owner.query(
        'SELECT capabilities FROM connector_refresh_hints WHERE tenant_id=$1 AND connection_id=$2 ORDER BY received_at,event_key',
        [tenantId, connectionId],
      )
    ).rows;
  const hintCount = (await hints()).length;
  await f.call('runs/operations/control', {
    action: 'advance',
    milliseconds: 1000,
  });
  await f.call('runs/operations/control', {
    action: 'command',
    instance: 'shopify',
    command: {
      kind: 'order-edit',
      order: '1',
      lines: [{ lineItem: lineId, quantity: 1 }],
    },
  });
  await until(
    async () =>
      (await hints())
        .slice(hintCount)
        .some(
          (row) =>
            row.capabilities.length === 2 &&
            row.capabilities.includes('orders.read') &&
            row.capabilities.includes('fulfillment.read'),
        ),
    'order edit delivered its signed reread hint',
    20_000,
  );
  await f.pilot.observe();
  const edited = await detail();
  expect(
    edited.sources.find((source) => source.connectionId === connectionId)
      .lines[0],
  ).toMatchObject({
    quantity: '2',
    currentQuantity: '1',
    cancelledQuantity: '1',
    remainingQuantity: '1',
  });
  expect(
    edited.fulfillments.some((work) =>
      work.lines.some(
        (line) => line.quantity === '1' && line.remainingQuantity === '1',
      ),
    ),
  ).toBe(true);
  const current = await f.db.owner.query(
    'SELECT snapshot_id FROM orders_projections WHERE tenant_id=$1 AND entity_id=$2 AND connection_id=$3',
    [tenantId, orderId, connectionId],
  );
  expect(current.rows[0].snapshot_id).not.toBe(before.id);
  expect(
    (
      await f.db.owner.query(
        'SELECT document FROM orders_snapshots WHERE tenant_id=$1 AND id=$2',
        [tenantId, before.id],
      )
    ).rows[0].document,
  ).toEqual(before.document);
  await f.call('runs/operations/control', {
    action: 'advance',
    milliseconds: 1000,
  });
  await f.call('runs/operations/control', {
    action: 'command',
    instance: 'shopify',
    command: {
      kind: 'order-edit',
      order: '1',
      lines: [{ lineItem: lineId, quantity: 0 }],
    },
  });
  await until(
    async () => (await hints()).length > hintCount + 2,
    'line removal delivered refresh hints',
    20_000,
  );
  await f.pilot.observe();
  const removed = await detail();
  expect(
    removed.fulfillments.some((work) =>
      work.lines.some(
        (line) => line.quantity === '0' && line.remainingQuantity === '0',
      ),
    ),
  ).toBe(true);
  expect(
    removed.sources.find((source) => source.connectionId === connectionId)
      .lines[0],
  ).toMatchObject({
    quantity: '2',
    currentQuantity: '0',
    cancelledQuantity: '2',
    remainingQuantity: '0',
  });
});
