import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createNativeStockRuntime } from '@luma/application-runtime';
import { test } from 'vitest';

import { nativeStockFixture as setup } from './native-stock-fixture.mjs';

test('native allocations retain real shortages, original receipts and exact cancellation releases under owned location versions', async (t) => {
  const f = await setup(t),
    proof = await f.shipmentRead();
  const available = (
    await f.store.transaction(f.owner, (tx) =>
      tx.accounts([{ ...f.base, state: 'available' }], false),
    )
  )[0];
  const input = {
    id: randomUUID(),
    key: randomUUID(),
    reservationId: randomUUID(),
    orderId: f.orderId,
    orderLineId: f.record.lines[0].id,
    orderVersion: f.record.version,
    connectionId: f.installed.id,
    locationId: f.base.locationId,
    quantity: '3.125001',
    unit: 'each',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    reservationVersion: null,
    available: { balance: available.balance, version: available.version },
    ownershipVersion: f.own.result.version,
    authorityRevision: (await f.authority(f.db).read(f.owner)).revision,
    shipmentReadId: proof.id,
  };
  const result = await f.native.reservations.allocate(f.owner, input);
  assert.equal(result.allocated, '3.125001');
  assert.equal(result.unallocated, '0.874999');
  assert.equal(result.reservation.remaining, '3.125001');
  const journey = (
    await f.f.request(f.f.owner, `${f.f.base}/orders/${f.orderId}`)
  ).journey;
  const reserved = journey.events.find((event) => event.stage === 'reserved');
  assert.equal(reserved.provenance, 'luma_action');
  assert.equal(reserved.actorId, f.owner.actor.id);
  assert.equal(reserved.occurredAt, result.reservation.createdAt);
  assert.ok(
    reserved.references.some(
      (ref) => ref.kind === 'reservation' && ref.id === result.reservation.id,
    ),
  );
  const restarted = createNativeStockRuntime(
    f.db,
    f.f.identity.service,
    async () => true,
    f.authority,
  );
  assert.deepEqual(
    await restarted.reservations.allocate(f.owner, input),
    result,
  );
  await assert.rejects(
    f.native.reservations.allocate(f.owner, { ...input, quantity: '3' }),
    (error) => error.code === 'changed_command',
  );
  const release = {
    id: randomUUID(),
    key: randomUUID(),
    reservationId: result.reservation.id,
    version: result.reservation.version,
    quantity: result.reservation.remaining,
    reason: 'cancel',
    shipmentReadId: proof.id,
  };
  const cancelled = await f.native.reservations.release(f.owner, release);
  assert.equal(cancelled.reservation.remaining, '0');
  assert.equal(cancelled.reservation.released, '3.125001');
  assert.deepEqual(
    await restarted.reservations.release(f.owner, release),
    cancelled,
  );
  assert.equal(
    (
      await f.store.transaction(f.owner, (tx) =>
        tx.pool(f.base.skuId, f.base.locationId, f.base.unit, false),
      )
    ).find((a) => a.address.state === 'available').balance,
    '12',
  );
  await f.runShopify({
    kind: 'cancel',
    order: f.rawOrder.id,
    reason: 'CUSTOMER',
  });
  await f.stockRead();
  const handback = await f.step('observe');
  assert.equal(handback.result.mode, 'observe');
  assert.equal(handback.result.version, '4');
  assert.equal(f.mutations.length, 0);
});

test('verified split shipments consume remaining units once and releases cannot race ahead of fresh shipment evidence', async (t) => {
  const f = await setup(t),
    proof = await f.shipmentRead();
  const available = (
    await f.store.transaction(f.owner, (tx) =>
      tx.accounts([{ ...f.base, state: 'available' }], false),
    )
  )[0];
  const allocation = await f.native.reservations.allocate(f.owner, {
    id: randomUUID(),
    key: randomUUID(),
    reservationId: randomUUID(),
    orderId: f.orderId,
    orderLineId: f.record.lines[0].id,
    orderVersion: f.record.version,
    connectionId: f.installed.id,
    locationId: f.base.locationId,
    quantity: '4',
    unit: 'each',
    expiresAt: null,
    reservationVersion: null,
    available: { balance: available.balance, version: available.version },
    ownershipVersion: f.own.result.version,
    authorityRevision: (await f.authority(f.db).read(f.owner)).revision,
    shipmentReadId: proof.id,
  });
  await f.runShopify({
    kind: 'fulfill',
    order: f.rawOrder.id,
    lines: [{ lineItem: f.rawOrder.lines[0].id, quantity: 1 }],
    carrier: 'Carrier',
    trackingNumber: 'FIRST',
    trackingUrl: 'https://example.test/FIRST',
  });
  const first = await f.shipmentRead();
  await assert.rejects(
    f.native.reservations.release(f.owner, {
      id: randomUUID(),
      key: randomUUID(),
      reservationId: allocation.reservation.id,
      version: '1',
      quantity: '4',
      reason: 'cancel',
      shipmentReadId: first.id,
    }),
    (error) => error.code === 'review_required',
  );
  const input = {
    id: randomUUID(),
    key: randomUUID(),
    orderId: f.orderId,
    shipmentReadId: first.id,
    expected: [{ id: allocation.reservation.id, version: '1' }],
  };
  const consumed = await f.native.reservations.consumeVerified(f.owner, input);
  assert.equal(consumed.consumed, '1');
  assert.equal(consumed.reservations[0].remaining, '3');
  assert.deepEqual(
    await f.native.reservations.consumeVerified(f.owner, input),
    consumed,
  );
  const duplicate = await f.native.reservations.consumeVerified(f.owner, {
    ...input,
    id: randomUUID(),
    key: randomUUID(),
    expected: [{ id: allocation.reservation.id, version: '2' }],
  });
  assert.equal(duplicate.consumed, '0');
  await f.runShopify({
    kind: 'fulfill',
    order: f.rawOrder.id,
    lines: [{ lineItem: f.rawOrder.lines[0].id, quantity: 2 }],
    carrier: 'Carrier',
    trackingNumber: 'SECOND',
    trackingUrl: 'https://example.test/SECOND',
  });
  const second = await f.shipmentRead();
  const next = await f.native.reservations.consumeVerified(f.owner, {
    id: randomUUID(),
    key: randomUUID(),
    orderId: f.orderId,
    shipmentReadId: second.id,
    expected: [{ id: allocation.reservation.id, version: '2' }],
  });
  assert.equal(next.consumed, '2');
  assert.equal(next.reservations[0].remaining, '1');
  const accounts = await f.store.transaction(f.owner, (tx) =>
    tx.pool(f.base.skuId, f.base.locationId, f.base.unit, false),
  );
  assert.equal(
    accounts.find((a) => a.address.state === 'reserved').balance,
    '1',
  );
  assert.equal(
    accounts.find((a) => a.address.state === 'customer').balance,
    '3',
  );
  assert.equal(f.mutations.length, 0);
});

test('Sales amendments and cancellation release only exact remaining reservations in the same transaction', async (t) => {
  const f = await setup(t),
    proof = await f.shipmentRead();
  const available = (
    await f.store.transaction(f.owner, (tx) =>
      tx.accounts([{ ...f.base, state: 'available' }], false),
    )
  )[0];
  const allocation = await f.native.reservations.allocate(f.owner, {
    id: randomUUID(),
    key: randomUUID(),
    reservationId: randomUUID(),
    orderId: f.orderId,
    orderLineId: f.record.lines[0].id,
    orderVersion: f.record.version,
    connectionId: f.installed.id,
    locationId: f.base.locationId,
    quantity: '4',
    unit: 'each',
    expiresAt: null,
    reservationVersion: null,
    available: { balance: available.balance, version: available.version },
    ownershipVersion: f.own.result.version,
    authorityRevision: (await f.authority(f.db).read(f.owner)).revision,
    shipmentReadId: proof.id,
  });
  await f.runShopify({
    kind: 'fulfill',
    order: f.rawOrder.id,
    lines: [{ lineItem: f.rawOrder.lines[0].id, quantity: 1 }],
    carrier: 'Carrier',
    trackingNumber: 'AMEND',
    trackingUrl: 'https://example.test/AMEND',
  });
  const shipped = await f.shipmentRead();
  await assert.rejects(
    f.sales.edit(f.owner, f.orderId, {
      commandId: randomUUID(),
      version: f.record.version,
      status: 'cancelled',
    }),
    (error) => error.code === 'review_required',
  );
  assert.equal((await f.sales.get(f.owner, f.orderId)).status, 'open');
  await f.native.reservations.consumeVerified(f.owner, {
    id: randomUUID(),
    key: randomUUID(),
    orderId: f.orderId,
    shipmentReadId: shipped.id,
    expected: [{ id: allocation.reservation.id, version: '1' }],
  });
  const input = {
    commandId: randomUUID(),
    version: f.record.version,
    lines: [{ id: f.record.lines[0].id, currentQuantity: '2' }],
  };
  const amended = await f.sales.edit(f.owner, f.orderId, input);
  assert.deepEqual(await f.sales.edit(f.owner, f.orderId, input), amended);
  const remaining = await f.native.store.transaction(f.owner, (tx) =>
    tx.reservation(allocation.reservation.id, false),
  );
  assert.equal(remaining.remaining, '1');
  assert.equal(remaining.consumed, '1');
  assert.equal(remaining.released, '2');
  const cancelled = await f.sales.edit(f.owner, f.orderId, {
    commandId: randomUUID(),
    version: amended.version,
    status: 'cancelled',
  });
  assert.equal(cancelled.status, 'cancelled');
  const terminal = await f.native.store.transaction(f.owner, (tx) =>
    tx.reservation(allocation.reservation.id, false),
  );
  assert.equal(terminal.remaining, '0');
  assert.equal(terminal.consumed, '1');
  assert.equal(terminal.released, '3');
  assert.equal(
    (
      await f.store.transaction(f.owner, (tx) =>
        tx.pool(f.base.skuId, f.base.locationId, f.base.unit, false),
      )
    ).find((a) => a.address.state === 'available').balance,
    '11',
  );
  assert.equal(f.mutations.length, 0);
});

test('due expiry releases once and busy order allocations cannot exceed remaining demand', async (t) => {
  const f = await setup(t),
    proof = await f.shipmentRead();
  const available = (
    await f.store.transaction(f.owner, (tx) =>
      tx.accounts([{ ...f.base, state: 'available' }], false),
    )
  )[0];
  const base = {
    orderId: f.orderId,
    orderLineId: f.record.lines[0].id,
    orderVersion: f.record.version,
    connectionId: f.installed.id,
    locationId: f.base.locationId,
    quantity: '3',
    unit: 'each',
    expiresAt: new Date(Date.now() + 1000).toISOString(),
    reservationVersion: null,
    available: { balance: available.balance, version: available.version },
    ownershipVersion: f.own.result.version,
    authorityRevision: (await f.authority(f.db).read(f.owner)).revision,
    shipmentReadId: proof.id,
  };
  const concurrent = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      f.native.reservations.allocate(f.owner, {
        ...base,
        id: randomUUID(),
        key: randomUUID(),
        reservationId: randomUUID(),
      }),
    ),
  );
  assert.equal(
    concurrent.filter((value) => value.status === 'fulfilled').length,
    1,
  );
  for (const value of concurrent.filter((value) => value.status === 'rejected'))
    assert.equal(value.reason.code, 'stale');
  const first = await f.native.reservations.expireDue(f.owner, 100);
  assert.equal(first.released.length, 0);
  let expired = first;
  const deadline = Date.now() + 5000;
  while (expired.released.length === 0 && Date.now() < deadline)
    expired = await f.native.reservations.expireDue(f.owner, 100);
  assert.equal(expired.released.length, 1);
  assert.deepEqual(await f.native.reservations.expireDue(f.owner, 100), {
    released: [],
    blocked: [],
    hasMore: false,
  });
  const reservation = await f.native.store.transaction(f.owner, (tx) =>
    tx.reservation(expired.released[0], false),
  );
  assert.equal(reservation.state, 'expired');
  assert.equal(reservation.released, '3');
  assert.equal(
    (
      await f.store.transaction(f.owner, (tx) =>
        tx.pool(f.base.skuId, f.base.locationId, f.base.unit, false),
      )
    ).find((a) => a.address.state === 'available').balance,
    '12',
  );
  assert.equal(f.mutations.length, 0);
});

test('changed workspace authority invalidates a prepared allocation without posting or changing ownership', async (t) => {
  const f = await setup(t),
    proof = await f.shipmentRead();
  const available = (
    await f.store.transaction(f.owner, (tx) =>
      tx.accounts([{ ...f.base, state: 'available' }], false),
    )
  )[0];
  const revision = (await f.authority(f.db).read(f.owner)).revision;
  const input = {
    id: randomUUID(),
    key: randomUUID(),
    reservationId: randomUUID(),
    orderId: f.orderId,
    orderLineId: f.record.lines[0].id,
    orderVersion: f.record.version,
    connectionId: f.installed.id,
    locationId: f.base.locationId,
    quantity: '4',
    unit: 'each',
    expiresAt: null,
    reservationVersion: null,
    available: { balance: available.balance, version: available.version },
    ownershipVersion: f.own.result.version,
    authorityRevision: revision,
    shipmentReadId: proof.id,
  };
  const latest = await f.shipmentRead();
  await assert.rejects(
    f.native.reservations.allocate(f.owner, input),
    (error) => error.code === 'stale',
  );
  input.shipmentReadId = latest.id;
  await f.authority(f.db).change(f.owner, {
    commandId: randomUUID(),
    revision,
    group: 'inventory_stock',
    connectionId: f.stock.erp,
  });
  await assert.rejects(
    f.native.reservations.allocate(f.owner, input),
    (error) => error.code === 'stale',
  );
  assert.equal(
    (await f.native.read.order(f.owner, f.orderId)).reservations.length,
    0,
  );
  const pool = await f.native.read.pool(f.owner, {
    ...f.base,
    connectionId: f.installed.id,
  });
  assert.equal(pool.scope.mode, 'own');
  assert.equal(pool.scope.version, f.own.result.version);
  assert.equal(
    pool.accounts.find((value) => value.address.state === 'available').balance,
    '12',
  );
  assert.equal(f.mutations.length, 0);
});

test('reservation balances remain tenant scoped and cannot be rewritten independently of their ledger', async (t) => {
  const f = await setup(t),
    proof = await f.shipmentRead();
  const available = (
    await f.store.transaction(f.owner, (tx) =>
      tx.accounts([{ ...f.base, state: 'available' }], false),
    )
  )[0];
  const result = await f.native.reservations.allocate(f.owner, {
    id: randomUUID(),
    key: randomUUID(),
    reservationId: randomUUID(),
    orderId: f.orderId,
    orderLineId: f.record.lines[0].id,
    orderVersion: f.record.version,
    connectionId: f.installed.id,
    locationId: f.base.locationId,
    quantity: '4',
    unit: 'each',
    expiresAt: null,
    reservationVersion: null,
    available: { balance: available.balance, version: available.version },
    ownershipVersion: f.own.result.version,
    authorityRevision: (await f.authority(f.db).read(f.owner)).revision,
    shipmentReadId: proof.id,
  });
  const nextAvailable = (
    await f.store.transaction(f.owner, (tx) =>
      tx.accounts([{ ...f.base, state: 'available' }], false),
    )
  )[0];
  const noopKey = randomUUID();
  const noop = await f.native.reservations.allocate(f.owner, {
    id: randomUUID(),
    key: noopKey,
    reservationId: result.reservation.id,
    orderId: f.orderId,
    orderLineId: f.record.lines[0].id,
    orderVersion: f.record.version,
    connectionId: f.installed.id,
    locationId: f.base.locationId,
    quantity: '1',
    unit: 'each',
    expiresAt: null,
    reservationVersion: result.reservation.version,
    available: {
      balance: nextAvailable.balance,
      version: nextAvailable.version,
    },
    ownershipVersion: f.own.result.version,
    authorityRevision: (await f.authority(f.db).read(f.owner)).revision,
    shipmentReadId: proof.id,
  });
  assert.equal(noop.allocated, '0');
  assert.equal(noop.ledger, null);
  await assert.rejects(
    f.ledger.reconcile(f.owner, {
      id: randomUUID(),
      key: noopKey,
      snapshotId: f.snapshot.id,
    }),
    (error) => error.code === 'changed_command',
  );
  await assert.rejects(
    f.db.transaction(f.owner.tenantId, (tx) =>
      tx.query(
        `UPDATE inventory_native_reservations SET remaining=3,released=1,version=2 WHERE tenant_id=$1 AND id=$2`,
        [f.owner.tenantId, result.reservation.id],
      ),
    ),
    (error) => error.code === '23514',
  );
  assert.equal(
    (await f.native.read.order(f.owner, f.orderId)).reservations[0].remaining,
    '4',
  );
  assert.equal(
    (
      await f.db.transaction(randomUUID(), (tx) =>
        tx.query(
          'SELECT id FROM inventory_native_reservations WHERE tenant_id=$1',
          [f.owner.tenantId],
        ),
      )
    ).rows.length,
    0,
  );
  await assert.rejects(
    f.native.read.order({ ...f.owner, tenantId: randomUUID() }, f.orderId),
  );
  assert.equal(f.mutations.length, 0);
});

test('failed stock reads pause older reconciliation evidence without overwriting native quantity', async (t) => {
  let fail = false;
  const f = await setup(t, {
    beforeShopifyRequest: (body) => {
      if (fail && body.query.includes('inventoryLevel'))
        throw new Error('Synthetic point read unavailable');
    },
  });
  const previous = await f.native.readStock(f.owner, {
    connectionId: f.installed.id,
    ...f.base,
  });
  fail = true;
  await assert.rejects(
    f.native.readStock(f.owner, { connectionId: f.installed.id, ...f.base }),
    (error) => error.code === 'source_incomplete',
  );
  await assert.rejects(
    f.ledger.reconcile(f.owner, {
      id: randomUUID(),
      key: randomUUID(),
      snapshotId: previous.snapshotId,
    }),
    (error) => error.code === 'source_incomplete',
  );
  assert.equal(
    (
      await f.native.read.pool(f.owner, {
        connectionId: f.installed.id,
        ...f.base,
      })
    ).accounts.find((account) => account.address.state === 'available').balance,
    '12',
  );
  fail = false;
  const refreshed = await f.native.readStock(f.owner, {
    connectionId: f.installed.id,
    ...f.base,
  });
  assert.equal(refreshed.complete, true);
  assert.equal(
    (
      await f.ledger.reconcile(f.owner, {
        id: randomUUID(),
        key: randomUUID(),
        snapshotId: refreshed.snapshotId,
      })
    ).driftQuantity,
    '0',
  );
  assert.equal(f.mutations.length, 0);
});

test('ownership evidence keeps each opened pool at a location separate', async (t) => {
  const f = await setup(t);
  await f.runShopify({
    kind: 'seed-catalog',
    products: [
      {
        id: '2',
        title: 'Linen pouch',
        vendor: 'Luma Goods',
        productType: 'Bags',
        published: true,
        variants: [
          {
            id: '2',
            sku: 'LUMA-002',
            title: 'Default Title',
            price: '12.00',
            barcode: '4006381333948',
            stock: { 1: 5 },
          },
        ],
      },
    ],
  });
  await f.syncRecords('inventory.read', {
    limit: 100,
    sku: { externalId: 'gid://shopify/InventoryItem/2', scopeKey: '' },
    location: { externalId: 'gid://shopify/Location/1', scopeKey: '' },
    includeComposition: true,
  });
  const second = (
    await f.f.db.owner.query(
      "SELECT s.id,s.document FROM inventory_snapshots s JOIN inventory_projections p ON p.tenant_id=s.tenant_id AND p.entity_id=s.entity_id AND p.connection_id=s.connection_id AND p.snapshot_id=s.id WHERE s.tenant_id=$1 AND s.connection_id=$2 AND s.kind='position' AND s.location_id=$3 AND s.sku_id<>$4",
      [f.owner.tenantId, f.installed.id, f.base.locationId, f.base.skuId],
    )
  ).rows;
  assert.equal(second.length, 1);
  const opening = await f.ledger.prepareOpening(f.owner, {
    id: randomUUID(),
    key: randomUUID(),
    snapshotId: second[0].id,
    reason: 'Second synthetic pool',
    balances: { available: '5' },
  });
  await f.ledger.review(f.admin, opening.id, true);
  await f.ledger.postReviewed(f.owner, opening.id);

  const { evidence, expected } = await f.native.store.transaction(
    f.owner,
    async (tx) => {
      const evidence = await tx.ownershipEvidence(
        f.installed.id,
        f.base.locationId,
      );
      // The per-pool ledger reads are the reference the set-based review must match.
      const expected = [];
      for (const pool of evidence.pools)
        expected.push({
          source: pool.source
            ? await tx.ledger.stockEvidence(pool.source.snapshotId)
            : null,
          comparison: pool.comparison
            ? await tx.ledger.comparison(pool.comparison.key)
            : null,
          accounts: await tx.ledger.pool(
            pool.skuId,
            f.base.locationId,
            pool.unit,
            false,
          ),
        });

      return { evidence, expected };
    },
  );
  const skus = [f.base.skuId, second[0].document.data.skuId].sort();
  assert.deepEqual(
    evidence.pools.map((pool) => pool.skuId),
    skus,
  );
  for (const [index, pool] of evidence.pools.entries()) {
    assert.equal(pool.source.skuId, pool.skuId);
    assert.equal(pool.opening.skuId, pool.skuId);
    assert.ok(pool.accounts.length > 0);
    assert.ok(pool.accounts.every((a) => a.address.skuId === pool.skuId));
    assert.deepEqual(
      {
        source: pool.source,
        comparison: pool.comparison,
        accounts: pool.accounts,
      },
      expected[index],
    );
  }
  // Only the fixture's SKU has a shadow reconciliation; the new pool must not borrow it.
  const [first, other] = skus.map((sku) =>
    evidence.pools.find((pool) => pool.skuId === sku),
  );
  const reconciled = first.skuId === f.base.skuId ? first : other,
    fresh = first.skuId === f.base.skuId ? other : first;
  assert.equal(reconciled.comparison.source.skuId, f.base.skuId);
  assert.equal(fresh.comparison, null);
});
