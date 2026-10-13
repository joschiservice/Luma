import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { test } from 'vitest';

import { transfersFixture } from './shopify-transfers-fixture.mjs';

test('transfers retain historical locations, exact relationships, receiving categories and separate stock balances', async (t) => {
  const {
    f,
    installed,
    stock,
    transfer,
    item,
    url,
    recordTransfer,
    syncRecords,
    mutations,
    store,
  } = await transfersFixture(t);
  const detail = await f.request(f.owner, url);
  assert.equal(detail.data.origin.name, 'Warehouse before rename');
  assert.equal(
    detail.data.origin.sourceId.externalId,
    'gid://shopify/Location/1',
  );
  assert.equal(detail.data.destination.name, 'Retired depot');
  assert.equal(detail.data.destination.locationId, null);
  assert.equal(detail.data.destination.sourceId, null);
  assert.equal(
    detail.data.lines[0].sourceId.externalId,
    'gid://shopify/InventoryTransferLineItem/1',
  );
  assert.equal(
    detail.data.lines[0].sourceSku.externalId,
    'gid://shopify/InventoryItem/1',
  );
  assert.ok(detail.data.lines[0].skuId);
  assert.equal(detail.shipments.length, 1);
  const shipment = detail.shipments[0];
  assert.deepEqual(shipment.signals, ['rejected', 'receipt_late']);
  const received = await f.request(
    f.owner,
    `${f.base}/inventory/transfers/${shipment.id}/sources/${installed.id}`,
  );
  assert.equal(received.data.acceptedQuantity, '7');
  assert.equal(received.data.receivedQuantity, '8');
  assert.equal(received.data.lines[0].unreceived, '2');
  assert.equal(received.transfers[0].id, item.id);
  assert.equal(received.purchaseOrders.length, 0);
  // Descriptive similarities do not create supply relationships; only exact, scoped references do.
  const supplierId = randomUUID(),
    purchaseOrderId = randomUUID();
  await f.request(f.owner, `${f.base}/procurement/suppliers`, 'POST', {
    id: supplierId,
    name: 'Transfer supplier',
    externalReferences: [],
  });
  const order = {
    id: purchaseOrderId,
    supplierId,
    reference: 'Receiving shipment',
    externalReferences: [
      {
        system: 'shopify_inventory_shipment',
        externalId: 'gid://shopify/InventoryShipment/1',
        connectionId: randomUUID(),
      },
    ],
    lines: [
      {
        id: randomUUID(),
        sku: detail.data.lines[0].skuId,
        description: 'Canvas tote',
        quantity: 10,
        unit: 'each',
      },
    ],
  };
  await f.request(
    f.owner,
    `${f.base}/procurement/purchase-orders`,
    'POST',
    order,
  );
  const shipmentUrl = `${f.base}/inventory/transfers/${shipment.id}/sources/${installed.id}`;
  assert.equal(
    (await f.request(f.owner, shipmentUrl)).purchaseOrders.length,
    0,
  );
  const linkedId = randomUUID();
  await f.request(f.owner, `${f.base}/procurement/purchase-orders`, 'POST', {
    ...order,
    id: linkedId,
    externalReferences: [
      {
        system: 'shopify_inventory_shipment',
        externalId: 'gid://shopify/InventoryShipment/1',
        connectionId: installed.id,
      },
    ],
  });
  assert.equal(
    (await f.request(f.owner, shipmentUrl)).purchaseOrders[0].id,
    linkedId,
  );
  const roleResponse = await f.app.inject({
    method: 'POST',
    url: `${f.base}/roles`,
    headers: {
      origin: 'http://localhost:3000',
      cookie: f.owner.cookie,
      'x-command-id': randomUUID(),
    },
    payload: {
      name: 'Inventory reader',
      description: 'Read receiving facts',
      permissions: ['inventory.read'],
    },
  });
  assert.equal(roleResponse.statusCode, 201, roleResponse.body);
  await f.request(f.owner, `${f.base}/members/${f.membership.id}`, 'PATCH', {
    roleId: roleResponse.json().id,
  });
  const restricted = await f.request(f.member, shipmentUrl);
  assert.deepEqual(restricted.hidden, ['purchaseOrders']);
  assert.equal(restricted.purchaseOrders.length, 0);
  const noAccess = await f.app.inject({
    method: 'PATCH',
    url: `${f.base}/roles/${roleResponse.json().id}`,
    headers: {
      origin: 'http://localhost:3000',
      cookie: f.owner.cookie,
      'x-command-id': randomUUID(),
    },
    payload: {
      name: 'Inventory reader',
      description: 'No operational reads',
      revision: roleResponse.json().revision,
      permissions: [],
    },
  });
  assert.equal(noAccess.statusCode, 200, noAccess.body);
  await f.request(f.member, shipmentUrl, 'GET', undefined, 403);

  assert.equal(received.source.externalId, 'gid://shopify/InventoryShipment/1');
  const filtered = await f.request(
    f.owner,
    `${f.base}/inventory/transfers?skuId=${detail.data.lines[0].skuId}`,
  );
  assert.equal(filtered.items[0].id, item.id);
  const mismatch = await f.request(
    f.owner,
    `${f.base}/inventory/transfers?locationId=${randomUUID()}`,
  );
  assert.equal(mismatch.items.length, 0);
  const position = (
    await f.request(f.owner, `${f.base}/inventory?connectionId=${installed.id}`)
  ).items[0];
  assert.equal(
    position.sources.find((s) => s.connectionId === installed.id).available,
    '12',
  );
  assert.equal(
    position.sources.find((s) => s.connectionId === installed.id).incoming,
    null,
  );
  assert.equal(mutations.length, 0);
  await f.request(f.outsider, url, 'GET', undefined, 404);
  const other = await f.request(
    f.owner,
    '/v1/organizations',
    'POST',
    {
      name: 'Other transfer tenant',
      slug: `other-transfers-${randomUUID().slice(0, 8)}`,
    },
    201,
  );
  await f.request(
    f.owner,
    `/v1/organizations/${other.id}/inventory/transfers/${item.id}/sources/${installed.id}`,
    'GET',
    undefined,
    404,
  );
  await f.request(
    f.owner,
    `${f.base}/inventory/transfers/${randomUUID()}/sources/${installed.id}`,
    'GET',
    undefined,
    404,
  );
  await f.request(
    f.owner,
    `${f.base}/inventory/transfers?cursor=not-a-cursor`,
    'GET',
    undefined,
    400,
  );
  // A later real read retains old line facts and explicitly marks an unavailable collection.
  transfer.shipments[0].lines = null;
  await recordTransfer(transfer);
  await syncRecords('inventory.shipments.read', { limit: 100 });
  const incomplete = await f.request(
    f.owner,
    `${f.base}/inventory/transfers/${shipment.id}/sources/${installed.id}`,
  );
  assert.equal(incomplete.record.evidence, 'incomplete');
  assert.deepEqual(incomplete.record.signals, []);
  assert.ok(incomplete.history.some((entry) => entry.receivedQuantity === '8'));
  await store.delete('InventoryTransfer', '1');
  await syncRecords('inventory.transfers.read', {
    limit: 100,
    confirmMissing: {
      externalId: 'gid://shopify/InventoryTransfer/1',
      scopeKey: '',
      createdAt: transfer.dateCreated,
    },
  });
  const removed = await f.request(f.owner, url);
  assert.equal(removed.deleted, true);
  assert.equal(removed.data, null);
  assert.equal(removed.record.name, 'Move to retired depot');
  assert.equal(removed.record.evidence, 'removed');
  assert.equal(removed.record.facts.requested, null);
  assert.equal(removed.record.facts.received, null);
  assert.deepEqual(removed.record.signals, []);
  assert.ok(
    removed.history.some(
      (entry) =>
        entry.origin?.sourceId?.externalId === 'gid://shopify/Location/1',
    ),
  );
  // Current permission removal prevents conclusions while retained history remains readable.
  await f.db.owner.query(
    `UPDATE connector_installations SET document=jsonb_set(document,'{granted}','["inventory.read"]') WHERE tenant_id=$1 AND id=$2`,
    [f.org.id, installed.id],
  );
  const unavailable = await f.request(f.owner, url);
  assert.equal(unavailable.record.evidence, 'unavailable');
  assert.deepEqual(unavailable.record.signals, []);
  assert.equal(stock.erp !== installed.id, true);
});

test('transfer lists bound payloads and bind pagination to exact workspace filters', async (t) => {
  const { f, transfer, installed, recordTransfer, syncRecords } =
    await transfersFixture(t);
  for (let index = 2; index <= 52; index++)
    await recordTransfer({
      ...transfer,
      id: String(index),
      name: `Move ${index}`,
      lines: [{ ...transfer.lines[0], id: String(index) }],
      shipments: [],
    });
  const imported = await syncRecords('inventory.transfers.read', {
    limit: 100,
  });
  assert.equal(imported.length, 52);
  const first = await f.request(
    f.owner,
    `${f.base}/inventory/transfers?connectionId=${installed.id}`,
  );
  assert.equal(first.items.length, 50);
  assert.ok(first.nextCursor);
  assert.equal(
    first.items.some((item) => 'lines' in item),
    false,
  );
  const second = await f.request(
    f.owner,
    `${f.base}/inventory/transfers?connectionId=${installed.id}&cursor=${first.nextCursor}`,
  );
  assert.equal(second.items.length, 2);
  assert.equal(second.nextCursor, null);
  assert.equal(
    new Set([...first.items, ...second.items].map((item) => item.id)).size,
    52,
  );
  await f.request(
    f.owner,
    `${f.base}/inventory/transfers?cursor=${first.nextCursor}`,
    'GET',
    undefined,
    400,
  );
  await f.request(
    f.owner,
    `${f.base}/inventory/transfers?connectionId=${installed.id}&kind=inventory_shipment&cursor=${first.nextCursor}`,
    'GET',
    undefined,
    400,
  );
});
