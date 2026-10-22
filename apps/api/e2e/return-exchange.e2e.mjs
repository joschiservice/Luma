import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  citedReturnReads,
  providerWrites,
  returnWriteReceipts,
  settlementFixture,
} from './return-settlement-fixture.mjs';

/**
 * Every read the case's exchange steps, exchange operation, settlements and audit cite resolves
 * to one stored, complete read; the operation's own reads are stored under its ID. Every write
 * receipt the case's attempts cite resolves to one stored receipt; with `accepted`, at least one
 * write's response arrived and cites one.
 */
async function expectStoredReads(f, operationId, { accepted = false } = {}) {
  const reads = await citedReturnReads(f, f.detail.case.id);
  expect(reads.cited.length).toBeGreaterThan(0);
  expect(reads.stored.map((row) => row.id)).toEqual(reads.cited);
  for (const row of reads.stored)
    expect(row).toMatchObject({
      case_id: f.detail.case.id,
      document: { caseId: f.detail.case.id, completeness: 'complete' },
    });
  const receipts = await returnWriteReceipts(f, f.detail.case.id);
  if (accepted)
    expect(receipts.some((attempt) => attempt.cited.length)).toBe(true);

  return reads.stored.filter((row) => row.subject_id === operationId);
}

it('tracks an even exchange through lost responses without a second replacement fulfillment', async (t) => {
  const f = await settlementFixture(t, {
      imported: true,
      resolution: 'exchange',
    }),
    { request, path, requester, approver } = f;
  const initial = await request(`${path}/exchange`);
  expect(initial.choiceStatus).toBe('ready');
  expect(initial.choices.length).toBeGreaterThan(0);
  const body = {
    id: randomUUID(),
    operationId: randomUUID(),
    kind: 'request',
    replacementId: initial.choices[0].id,
    quantity: 2,
  };
  const requested = await request(`${path}/exchange/steps`, body);
  expect(requested.state).toBe('approval_required');
  await request(
    `${path}/exchange/steps/${requested.id}/decision`,
    { decisionId: requested.decisionId, outcome: 'approved' },
    requester,
    409,
  );
  await f.call('runs/operations/control', {
    action: 'fault',
    rule: {
      instance: 'shopify',
      operation: 'returns.exchange.request',
      kind: 'response-loss',
      remaining: 1,
    },
  });
  const approved = await request(
    `${path}/exchange/steps/${requested.id}/decision`,
    { decisionId: requested.decisionId, outcome: 'approved' },
    approver,
  );
  expect(approved).toMatchObject({
    state: 'verified',
    sent: true,
    proof: { outcome: 'passed', processLines: {}, financial: { kind: 'even' } },
  });
  expect((await request(`${path}/exchange/steps`, body)).id).toBe(requested.id);
  await request(
    `${path}/exchange/steps`,
    { ...body, id: randomUUID(), operationId: randomUUID() },
    requester,
    409,
  );
  const processing = await request(`${path}/exchange/steps`, {
    id: randomUUID(),
    operationId: body.operationId,
    kind: 'process',
  });
  await f.call('runs/operations/control', {
    action: 'fault',
    rule: {
      instance: 'shopify',
      operation: 'returns.exchange.process',
      kind: 'response-loss',
      remaining: 1,
    },
  });
  const prepared = await request(
    `${path}/exchange/steps/${processing.id}/decision`,
    { decisionId: processing.decisionId, outcome: 'approved' },
    approver,
  );
  expect(prepared).toMatchObject({
    state: 'verified',
    sent: true,
    proof: {
      outcome: 'passed',
      fulfillmentReady: true,
      payment: 'not_required',
    },
  });
  await request(`${path}/exchange/steps/${processing.id}/send`, {});
  await request(
    `${path}/exchange/steps`,
    { id: randomUUID(), operationId: body.operationId, kind: 'process' },
    requester,
    409,
  );
  const works = (
    await f.call(
      'runs/operations/records/shopify?kind=FulfillmentOrder&limit=100',
    )
  ).items.filter((w) => w.data.order === f.providerOrderId);
  expect(works).toHaveLength(2);
  // Shopify received each exchange write once, and each response was lost.
  for (const operation of [
    'returns.exchange.request',
    'returns.exchange.process',
  ])
    await expect
      .poll(() => providerWrites(f, 'shopify', operation), { timeout: 5_000 })
      .toEqual(['response-loss']);
  expect((await request(`${path}/exchange`)).operation).toMatchObject({
    id: body.operationId,
    processingStarted: true,
  });
  await request(
    `${path}/exchange/choice`,
    {
      revision: (await request(`${path}/exchange`)).operation.revision,
      kind: 'different_item',
    },
    requester,
    409,
  );
  await f.pilot.observe({ check: false });
  const caseView = await request(path);
  expect(caseView.case.state).toBe('open');
  expect(caseView.sourceReturn).not.toBeNull();
  await expectStoredReads(f, body.operationId);
});

it('keeps a price difference unpaid and held until actual merchant payment and independently approved release', async (t) => {
  const f = await settlementFixture(t, {
      imported: true,
      resolution: 'exchange',
    }),
    { request, path, approver, requester } = f;
  const choices = (await request(`${path}/exchange`)).choices,
    replacement = choices[0];
  const variant = (
    await f.call(
      'runs/operations/records/shopify?kind=ProductVariant&limit=100',
    )
  ).items.find(
    (v) => replacement.variantId === `gid://shopify/ProductVariant/${v.id}`,
  );
  await f.command({
    kind: 'product-update',
    product: variant.data.product,
    price: ((variant.data.price + 100) / 100).toFixed(2),
  });
  const operationId = randomUUID(),
    requested = await request(`${path}/exchange/steps`, {
      id: randomUUID(),
      operationId,
      kind: 'request',
      replacementId: replacement.id,
      quantity: 2,
    });
  const intent = await request(
    `${path}/exchange/steps/${requested.id}/decision`,
    { decisionId: requested.decisionId, outcome: 'approved' },
    approver,
  );
  expect(intent.proof.financial).toMatchObject({
    kind: 'charge',
    amount: '2.0',
  });
  const process = await request(`${path}/exchange/steps`, {
      id: randomUUID(),
      operationId,
      kind: 'process',
    }),
    prepared = await request(
      `${path}/exchange/steps/${process.id}/decision`,
      { decisionId: process.decisionId, outcome: 'approved' },
      approver,
    );
  expect(prepared).toMatchObject({
    state: 'verified',
    proof: { payment: 'pending', fulfillmentReady: false },
  });
  expect(prepared.proof.paymentHoldId).toBeTruthy();
  await request(
    `${path}/exchange/steps`,
    { id: randomUUID(), operationId, kind: 'release' },
    requester,
    409,
  );
  await f.command({ kind: 'exchange-pay', order: f.providerOrderId });
  const paid = await request(`${path}/exchange/steps/${process.id}/check`, {});
  expect(paid.proof).toMatchObject({
    payment: 'paid',
    fulfillmentReady: false,
  });
  const release = await request(`${path}/exchange/steps`, {
    id: randomUUID(),
    operationId,
    kind: 'release',
  });
  expect(release.state).toBe('approval_required');
  const released = await request(
    `${path}/exchange/steps/${release.id}/decision`,
    { decisionId: release.decisionId, outcome: 'approved' },
    approver,
  );
  expect(released).toMatchObject({
    state: 'verified',
    proof: { payment: 'paid', fulfillmentReady: true },
  });
  expect((await request(path)).case.state).toBe('open');
  await expectStoredReads(f, operationId, { accepted: true });
});

it('verifies a cheaper replacement refund only after actual money settlement and does not restock through Shopify', async (t) => {
  const f = await settlementFixture(t, {
    imported: true,
    resolution: 'exchange',
  });
  const { request, path, approver } = f;
  const replacement = (await request(`${path}/exchange`)).choices[0];
  const variant = (
    await f.call(
      'runs/operations/records/shopify?kind=ProductVariant&limit=100',
    )
  ).items.find(
    (v) => replacement.variantId === `gid://shopify/ProductVariant/${v.id}`,
  );
  await f.command({
    kind: 'product-update',
    product: variant.data.product,
    price: ((variant.data.price - 100) / 100).toFixed(2),
  });
  const operationId = randomUUID();
  const requested = await request(`${path}/exchange/steps`, {
    id: randomUUID(),
    operationId,
    kind: 'request',
    replacementId: replacement.id,
    quantity: 2,
  });
  const intent = await request(
    `${path}/exchange/steps/${requested.id}/decision`,
    {
      decisionId: requested.decisionId,
      outcome: 'approved',
    },
    approver,
  );
  expect(intent.proof.financial).toMatchObject({
    kind: 'refund',
    amount: '2.0',
  });
  const process = await request(`${path}/exchange/steps`, {
    id: randomUUID(),
    operationId,
    kind: 'process',
  });
  const prepared = await request(
    `${path}/exchange/steps/${process.id}/decision`,
    {
      decisionId: process.decisionId,
      outcome: 'approved',
    },
    approver,
  );
  expect(prepared).toMatchObject({
    state: 'verified',
    proof: { payment: 'pending', fulfillmentReady: true },
  });
  await request(`${path}/exchange/steps/${process.id}/send`, {});
  const refunds = (
    await f.call('runs/operations/records/shopify?kind=Refund&limit=100')
  ).items.filter((r) => r.data.order === f.providerOrderId);
  expect(refunds).toHaveLength(1);
  const lines = (
    await f.call(
      'runs/operations/records/shopify?kind=RefundLineItem&limit=100',
    )
  ).items.filter((r) => r.data.refund === refunds[0].id);
  expect(
    lines.map((r) => [r.data.quantity, r.data.restockType, r.data.restocked]),
  ).toEqual([[2, 'NO_RESTOCK', false]]);
  await f.command({ kind: 'refund-settle', order: f.providerOrderId });
  const paid = await request(`${path}/exchange/steps/${process.id}/check`, {});
  expect(paid.proof.payment).toBe('paid');
  expect((await request(path)).case.state).toBe('open');
  await expectStoredReads(f, operationId, { accepted: true });
});

it('owns an unavailable replacement and hands off to refund only after governed cancellation without changing resale stock', async (t) => {
  const f = await settlementFixture(t, {
      imported: true,
      resolution: 'exchange',
    }),
    { request, path, approver, requester } = f;
  const target = (await request(`${path}/settlements`)).targets.find(
    (t) => t.warehouse.externalId !== 'all-warehouses',
  );
  const stock = await request(`${path}/settlements`, {
    id: randomUUID(),
    kind: 'restock',
    targetId: target.id,
  });
  await request(
    `${path}/settlements/${stock.id}/decision`,
    { decisionId: stock.decisionId, outcome: 'approved' },
    approver,
  );
  const choice = (await request(`${path}/exchange`)).choices[0],
    operationId = randomUUID();
  const requested = await request(`${path}/exchange/steps`, {
    id: randomUUID(),
    operationId,
    kind: 'request',
    replacementId: choice.id,
    quantity: 2,
  });
  await request(
    `${path}/exchange/steps/${requested.id}/decision`,
    { decisionId: requested.decisionId, outcome: 'approved' },
    approver,
  );
  const variantId = choice.variantId.split('/').at(-1),
    levels = (
      await f.call(
        'runs/operations/records/shopify?kind=InventoryLevel&limit=100',
      )
    ).items.filter((l) => l.data.item === variantId);
  for (const level of levels)
    await f.command({
      kind: 'stock',
      variant: variantId,
      location: level.data.location,
      quantity: 0,
    });
  await request(
    `${path}/exchange/steps`,
    { id: randomUUID(), operationId, kind: 'process' },
    requester,
    409,
  );
  let current = await request(`${path}/exchange`);
  expect(current.operation.availability.available).toBe(false);
  expect(current.operation.processingStarted).toBe(false);
  const waited = await request(`${path}/exchange/choice`, {
    revision: current.operation.revision,
    kind: 'wait',
  });
  expect(waited.ownerId).toBe(f.detail.case.openedBy.id);
  current = await request(`${path}/exchange`);
  await request(`${path}/exchange/choice`, {
    revision: current.operation.revision,
    kind: 'refund',
  });
  const cancel = await request(`${path}/exchange/steps`, {
    id: randomUUID(),
    operationId,
    kind: 'cancel',
  });
  await f.call('runs/operations/control', {
    action: 'fault',
    rule: {
      instance: 'shopify',
      operation: 'returns.exchange.cancel',
      kind: 'response-loss',
      remaining: 1,
    },
  });
  const cancelled = await request(
    `${path}/exchange/steps/${cancel.id}/decision`,
    { decisionId: cancel.decisionId, outcome: 'approved' },
    approver,
  );
  expect(cancelled.state).toBe('verified');
  current = await request(`${path}/exchange`);
  await request(`${path}/exchange/refund`, {
    revision: current.operation.revision,
  });
  const detail = await request(path);
  expect(detail.proposal.kind).toBe('refund');
  expect(detail.lines[0].restock).toBe(1);
  const refund = await request(`${path}/settlements`, {
    id: randomUUID(),
    kind: 'refund',
  });
  expect(refund.state).toBe('approval_required');
  expect(
    (
      await f.call(
        'runs/operations/records/shopify?kind=FulfillmentOrder&limit=100',
      )
    ).items.filter((w) => w.data.order === f.providerOrderId),
  ).toHaveLength(1);
  expect(
    (
      await f.call('runs/operations/records/jtl?kind=stock-change&limit=100')
    ).items.filter((r) => r.data.comment === `luma-rs:${stock.id}`),
  ).toHaveLength(1);
  // The operation stores the read that showed the replacement unavailable.
  const operationReads = await expectStoredReads(f, operationId);
  expect(operationReads.map((row) => row.id)).toEqual(
    expect.arrayContaining(current.operation.availability.evidenceRefs),
  );
  expect(operationReads[0]).toMatchObject({ purpose: 'exchange' });
});
