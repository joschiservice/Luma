import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

import { createInventoryLedgerRuntime } from '@luma/application-runtime';
import { createAuditLog } from '@luma/audit/composition';
import {
  createPurchaseIncoming,
  createPurchaseIncomingStore,
} from '@luma/inventory/composition';
import { canonicalJson } from '@luma/platform';
import {
  createIncomingStockReader,
  createProcurement,
} from '@luma/procurement/composition';
import { test } from 'vitest';

import { nativeStockFixture } from './native-stock-fixture.mjs';

test('native supplier arrivals retain order provenance, consume reviewed receipts once, and leave available stock separate', async (t) => {
  const f = await nativeStockFixture(t);
  const procurement = createProcurement(
    f.db,
    f.f.identity.service.refreshContext,
    createAuditLog,
  );
  const supplierId = randomUUID(),
    purchaseOrderId = randomUUID(),
    lineId = randomUUID();
  await procurement.createSupplier(f.owner, {
    id: supplierId,
    name: 'Native supplier',
    externalReferences: [],
  });
  await procurement.createOrder(f.owner, {
    id: purchaseOrderId,
    supplierId,
    reference: 'NATIVE-PO-1',
    authority: 'luma',
    externalReferences: [],
    origin: {},
    lines: [
      {
        id: lineId,
        sku: f.base.skuId,
        description: 'Native stock item',
        quantity: 100,
        unit: 'each',
        locationId: f.base.locationId,
      },
    ],
  });
  await procurement.transition(f.owner, purchaseOrderId, {
    id: randomUUID(),
    expectedRevision: 1,
    status: 'open',
    reason: 'Synthetic verified submission',
  });
  const arrival = new Date(Date.now() + 3 * 86400000)
    .toISOString()
    .slice(0, 10);
  let source = {
    complete: true,
    revision: 'a'.repeat(64),
    evidenceRefs: [purchaseOrderId],
    lines: [
      {
        lineId,
        ...f.base,
        scopeVersion: f.own.result.version,
        expectedQuantity: '100',
        observedAt: new Date().toISOString(),
        expectedDate: arrival,
        dateConfidence: 'requested',
      },
    ],
  };
  const hash = (value) =>
    createHash('sha256').update(canonicalJson(value)).digest('hex');
  const compose = () =>
    createPurchaseIncoming({
      store: createPurchaseIncomingStore(
        f.db,
        createAuditLog,
        async () => source,
      ),
      refreshContext: f.f.identity.service.refreshContext,
      enabled: async () => true,
      hash,
      uuid: () => randomUUID(),
    });
  const incoming = compose();
  await incoming.reconcile(f.owner, purchaseOrderId);
  const pool = () =>
    f.store.transaction(f.owner, (tx) =>
      tx.pool(f.base.skuId, f.base.locationId, 'each', false),
    );
  assert.equal(
    (await pool()).find((a) => a.address.state === 'incoming').balance,
    '100',
  );
  assert.equal(
    (await pool()).find((a) => a.address.state === 'available').balance,
    '12',
  );
  assert.equal(
    (await compose().reconcile(f.owner, purchaseOrderId)).updated,
    0,
  );
  source = {
    ...source,
    revision: 'b'.repeat(64),
    lines: source.lines.map((line) => ({
      ...line,
      expectedQuantity: '70',
      dateConfidence: 'confirmed',
    })),
  };
  await incoming.reconcile(f.owner, purchaseOrderId);
  assert.equal(
    (await pool()).find((a) => a.address.state === 'incoming').balance,
    '70',
  );
  const reader = createIncomingStockReader(f.db);
  assert.deepEqual(
    (await reader(f.owner, { skuIds: [f.base.skuId] })).items
      .filter((item) => item.source === 'ledger')
      .map((item) => [
        item.quantity,
        item.orderReference,
        item.expectedDate,
        item.dateStatus,
      ]),
    [[70, 'NATIVE-PO-1', arrival, 'confirmed']],
  );
  const receivedId = randomUUID(),
    damagedId = randomUUID();
  for (const [id, kind, quantity] of [
    [receivedId, 'received', 32],
    [damagedId, 'damaged', 2],
  ]) {
    const fact = {
      id,
      tenantId: f.owner.tenantId,
      purchaseOrderId,
      lineId,
      kind,
      quantity,
      date: null,
      text: null,
      source: {
        kind: 'manual_receipt',
        receivedAt: new Date().toISOString(),
        condition: 'mixed',
        reason: 'Synthetic partial receipt',
        evidence: ['DN-1'],
      },
      status: 'confirmed',
      reviewReasons: [],
      supersedes: null,
      recordedAt: new Date().toISOString(),
      recordedBy: { kind: 'user', id: f.owner.actor.id },
      review: null,
    };
    await f.f.db.owner.query(
      'INSERT INTO procurement_commitments(tenant_id,id,purchase_order_id,source_key,document,recorded_at) VALUES($1,$2,$3,$4,$5,$6)',
      [f.owner.tenantId, id, purchaseOrderId, id, fact, fact.recordedAt],
    );
  }
  const ledger = createInventoryLedgerRuntime(
    f.db,
    f.f.identity.service,
    async () => true,
  );
  const review = await ledger.preparePurchaseReceipt(f.owner, {
    id: randomUUID(),
    purchaseOrderId,
    lineId,
    reason: 'Review physical delivery note',
  });
  assert.equal(
    review.command.postings.find((p) => p.account.state === 'incoming')
      .quantity,
    '-32',
  );
  await ledger.review(f.admin, review.id, true);
  const posted = await ledger.postReviewed(f.owner, review.id);
  assert.deepEqual(await ledger.postReviewed(f.owner, review.id), posted);
  assert.equal(
    (await ledger.verifyPurchaseReceipt(f.owner, review.id)).outcome,
    'verified',
  );
  assert.equal(
    (await pool()).find((a) => a.address.state === 'incoming').balance,
    '38',
  );
  assert.equal(
    (await pool()).find((a) => a.address.state === 'available').balance,
    '42',
  );
  assert.equal(
    (await pool()).find((a) => a.address.state === 'damaged').balance,
    '2',
  );
  assert.equal(
    (await compose().reconcile(f.owner, purchaseOrderId)).updated,
    0,
  );
  assert.equal(
    (await reader(f.owner, { skuIds: [f.base.skuId] })).items.filter(
      (item) => item.source === 'ledger',
    )[0].quantity,
    38,
  );
  source = {
    ...source,
    revision: 'c'.repeat(64),
    lines: source.lines.map((line) => ({ ...line, expectedQuantity: '0' })),
  };
  await incoming.reconcile(f.owner, purchaseOrderId);
  assert.equal(
    (await pool()).find((a) => a.address.state === 'incoming').balance,
    '0',
  );
  assert.equal(
    (await pool()).find((a) => a.address.state === 'available').balance,
    '42',
  );
  assert.equal(
    (await reader(f.owner, { skuIds: [f.base.skuId] })).items.length,
    0,
  );
});
