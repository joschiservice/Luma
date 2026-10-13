import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createInventoryLedgerRuntime } from '@luma/application-runtime';
import { createAuditLog } from '@luma/audit/composition';
import {
  createProcurement,
  createSupplierCommitmentService,
} from '@luma/procurement/composition';
import { test } from 'vitest';

import { nativeStockFixture } from './native-stock-fixture.mjs';

test('native purchase receipts book good and damaged units through peer review, with exact retry and independent readback', async (t) => {
  const f = await nativeStockFixture(t);
  const procurement = createProcurement(
    f.db,
    f.f.identity.service.refreshContext,
    createAuditLog,
  );
  const supplier = await procurement.createSupplier(f.owner, {
    id: randomUUID(),
    name: 'Manual supplier',
  });
  const lineId = randomUUID();
  const draft = await procurement.createOrder(f.owner, {
    id: randomUUID(),
    supplierId: supplier.id,
    reference: 'NATIVE-RECEIPT',
    lines: [
      {
        id: lineId,
        sku: f.base.skuId,
        locationId: f.base.locationId,
        description: 'Receivable item',
        quantity: 100,
        unit: 'each',
      },
    ],
  });
  await procurement.transition(f.owner, draft.id, {
    id: randomUUID(),
    expectedRevision: draft.revision,
    status: 'open',
    reason: 'Order sent and accepted outside the purchasing system',
  });
  const commitments = createSupplierCommitmentService(f.db, createAuditLog, {
    purchasing: null,
    admission: null,
    refreshContext: f.f.identity.service.refreshContext,
    principal: (actorId, tenantId) =>
      f.f.identity.service.resolveWorkflowContext(
        actorId,
        tenantId,
        randomUUID(),
      ),
    openOrder: async () => {},
    trace: () => ({
      traceId: randomUUID(),
      spanId: randomUUID(),
      requestId: randomUUID(),
    }),
    model: { gateway: null, available: false, reason: 'Manual evidence' },
    reconciliationAvailable: async () => true,
  });
  const receipt = await commitments.recordReceipt(f.owner, draft.id, {
    id: randomUUID(),
    lineId,
    kind: 'received',
    quantity: 40,
    damagedQuantity: 2,
    expectedCommitmentId: null,
    expectedDamagedCommitmentId: null,
    receivedAt: new Date().toISOString(),
    condition: 'mixed',
    reason: 'Two damaged units on the signed delivery note',
    evidence: ['delivery-note:40', 'photo:damaged-2'],
  });
  const ledger = createInventoryLedgerRuntime(
    f.db,
    f.f.identity.service,
    async () => true,
  );
  const request = {
    id: randomUUID(),
    purchaseOrderId: draft.id,
    lineId,
    reason: 'Book signed receipt; damaged units stay unavailable',
  };
  const review = await ledger.preparePurchaseReceipt(f.owner, request);
  assert.equal(review.command.purchaseReceipt.cumulativeGood, '38');
  assert.equal(
    review.command.postings.find((p) => p.account.state === 'available')
      .quantity,
    '38',
  );
  assert.equal(
    review.command.postings.find((p) => p.account.state === 'damaged').quantity,
    '2',
  );
  assert.deepEqual(
    await ledger.preparePurchaseReceipt(f.owner, request),
    review,
  );
  await assert.rejects(
    ledger.review(f.owner, review.id, true),
    (error) => error.code === 'review_required',
  );
  await assert.rejects(
    ledger.postReviewed(f.owner, review.id),
    (error) => error.code === 'review_required',
  );
  await ledger.review(f.admin, review.id, true);
  const posted = await ledger.postReviewed(f.owner, review.id);
  assert.equal(
    posted.accounts.find((a) => a.address.state === 'available').balance,
    '50',
  );
  assert.equal(
    posted.accounts.find((a) => a.address.state === 'damaged').balance,
    '2',
  );
  assert.equal(
    (await ledger.verifyPurchaseReceipt(f.owner, review.id)).outcome,
    'verified',
  );
  const restarted = createInventoryLedgerRuntime(
    f.db,
    f.f.identity.service,
    async () => true,
  );
  assert.deepEqual(await restarted.postReviewed(f.owner, review.id), posted);
  assert.equal(
    (await restarted.purchaseReceiptReviews(f.admin, draft.id)).items.length,
    1,
  );
  assert.deepEqual(
    (await restarted.purchaseReceiptReviews(f.owner, draft.id)).ownedLineIds,
    [lineId],
  );
  const initialDamage = (
    await commitments.order(f.owner, draft.id)
  ).commitments.find((c) => c.kind === 'damaged');
  const second = await commitments.recordReceipt(f.owner, draft.id, {
    id: randomUUID(),
    lineId,
    kind: 'received',
    quantity: 60,
    damagedQuantity: 3,
    expectedCommitmentId: receipt.id,
    expectedDamagedCommitmentId: initialDamage.id,
    receivedAt: new Date().toISOString(),
    condition: 'mixed',
    reason: 'Next delivery: one further damaged unit',
    evidence: ['delivery-note:60', 'photo:damaged-3'],
  });
  const next = await restarted.preparePurchaseReceipt(f.owner, {
    ...request,
    id: randomUUID(),
  });
  assert.equal(
    next.command.postings.find((p) => p.account.state === 'available').quantity,
    '19',
  );
  await restarted.review(f.admin, next.id, true);
  const secondDamage = (await commitments.order(f.owner, draft.id)).commitments
    .filter((c) => c.kind === 'damaged')
    .at(-1);
  await commitments.recordReceipt(f.owner, draft.id, {
    id: randomUUID(),
    lineId,
    kind: 'received',
    quantity: 60,
    damagedQuantity: 4,
    expectedCommitmentId: second.id,
    expectedDamagedCommitmentId: secondDamage.id,
    receivedAt: new Date().toISOString(),
    condition: 'mixed',
    reason: 'Correction before stock booking: fourth damaged unit',
    evidence: ['photo:damaged-4'],
  });
  await assert.rejects(
    restarted.postReviewed(f.owner, next.id),
    (error) => error.code === 'stale',
  );
  assert.equal(
    (await restarted.verifyPurchaseReceipt(f.owner, review.id)).outcome,
    'verified',
  );
  const disabled = createInventoryLedgerRuntime(
    f.db,
    f.f.identity.service,
    async () => false,
  );
  await assert.rejects(
    disabled.preparePurchaseReceipt(f.owner, { ...request, id: randomUUID() }),
    (error) => error.code === 'review_required',
  );
  // A release toggle cannot prevent reading an already committed outcome.
  assert.equal(
    (await disabled.verifyPurchaseReceipt(f.owner, review.id)).outcome,
    'verified',
  );
});
