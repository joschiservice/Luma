import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { completionFixture } from './return-completion-fixture.mjs';
import { citedReturnReads } from './return-settlement-fixture.mjs';

it('independently completes stock, one reserved replacement and a settled net refund across Shopify and Wawi after lost write responses', async (t) => {
  const f = await completionFixture(t);
  const { request, path } = f;
  await request('/return-deadlines', {
    commandId: randomUUID(),
    expectedRevision: 0,
    enabled: true,
    receiptHours: 1,
    inspectionHours: 1,
    financialHours: 1,
    sourceMaxAgeSeconds: 300,
  });
  await f.recordPhysical();
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
  const operationId = randomUUID(),
    requested = await request(`${path}/exchange/steps`, {
      id: randomUUID(),
      operationId,
      kind: 'request',
      replacementId: replacement.id,
      quantity: 2,
    });
  expect(
    await f.approve('exchange/steps', requested.id, requested.decisionId),
  ).toMatchObject({ state: 'verified', proof: { outcome: 'passed' } });
  await f.command({ kind: 'return-receive', order: f.providerOrderId });
  const target = (await request(`${path}/settlements`)).targets.find(
    (t) => t.warehouse.externalId !== 'all-warehouses',
  );
  const stock = await request(`${path}/settlements`, {
    id: randomUUID(),
    kind: 'restock',
    targetId: target.id,
  });
  await f.call('runs/operations/control', {
    action: 'fault',
    rule: {
      instance: 'jtl',
      operation: 'returns.restock',
      kind: 'response-loss',
      remaining: 1,
    },
  });
  expect(
    (await f.approve('settlements', stock.id, stock.decisionId)).proof.outcome,
  ).toBe('passed');
  const process = await request(`${path}/exchange/steps`, {
    id: randomUUID(),
    operationId,
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
  const prepared = await f.approve(
    'exchange/steps',
    process.id,
    process.decisionId,
  );
  expect(prepared.proof.payment).toBe('pending');
  expect(
    (await request(`${path}/waiting/check`, {})).episodes.some(
      (e) => e.state === 'waiting',
    ),
  ).toBe(true);
  let report = await request(`${path}/exchange/complete`, {});
  expect(report.state).toBe('unresolved');
  expect(report.ownerId).toBe(f.detail.case.openedBy.id);
  expect(report.replacementTotal).not.toBeNull();
  await f.createWawi(operationId, replacement, report.replacementTotal);
  report = await request(`${path}/exchange/complete`, {});
  expect(
    report.checks.find((c) => c.id === 'reservation').verified,
    JSON.stringify(report),
  ).toBe(true);
  expect(report.checks.find((c) => c.id === 'payment').verified).toBe(false);
  expect((await request(path)).case.state).toBe('open');
  await f.call('runs/operations/control', {
    action: 'fault',
    rule: {
      instance: 'shopify',
      operation: 'returns.exchange.price.read',
      kind: 'malformed',
      remaining: 1,
    },
  });
  const missingPrice = await request(`${path}/exchange/complete`, {});
  expect(missingPrice).toMatchObject({
    state: 'unresolved',
    replacementTotal: null,
    ownerId: f.detail.case.openedBy.id,
  });
  expect(missingPrice.checks.find((c) => c.id === 'payment')).toMatchObject({
    verified: false,
    reason: 'price_mismatch',
  });
  await f.command({ kind: 'refund-settle', order: f.providerOrderId });
  // Read from each native source again; neither API acceptance nor a prior paid check can close the case.
  report = await request(`${path}/exchange/complete`, {});
  expect(report.state).toBe('verified');
  expect(
    (await request(`${path}/exchange`)).steps.find((s) => s.id === process.id)
      .proof.payment,
  ).toBe('paid');
  expect(report.checks.every((c) => c.verified)).toBe(true);
  expect((await request(path)).case).toMatchObject({
    state: 'completed',
    stage: 'completed',
  });
  await f.pilot.observe({ check: false });
  const bound = (await request(path)).case;
  expect(bound.sourceReturnId).not.toBeNull();
  const availability = await request(`/orders/${bound.orderId}/return-cases`);
  const source = availability.sources.find(
    (s) => s.connectionId === bound.connectionId,
  );
  expect(source.lines[0]).toMatchObject({
    inCases: 2,
    inStoreReturns: 0,
    returnable: 0,
  });
  expect(
    source.storeReturns.find((r) => r.id === bound.sourceReturnId).caseId,
  ).toBe(bound.id);
  await request(
    `/orders/${bound.orderId}/return-cases`,
    {
      id: randomUUID(),
      connectionId: bound.connectionId,
      sourceReturnId: bound.sourceReturnId,
      lines: f.lines.map((l) => ({
        orderLineId: l.orderLineId,
        quantity: 2,
        reason: 'other',
        note: null,
      })),
    },
    f.requester,
    409,
  );
  expect(
    (await request(`${path}/waiting`)).episodes.every(
      (e) => !['waiting', 'escalated'].includes(e.state),
    ),
  ).toBe(true);
  expect((await request(`${path}/exchange/complete`, {})).state).toBe(
    'verified',
  );
  await request(`${path}/settlements/${stock.id}/send`, {});
  await request(`${path}/exchange/steps/${process.id}/send`, {});
  expect(
    (
      await f.call('runs/operations/records/jtl?kind=stock-change&limit=100')
    ).items.filter((r) => r.data.comment === `luma-rs:${stock.id}`),
  ).toHaveLength(1);
  expect(
    (
      await f.call('runs/operations/records/jtl?kind=sales-order&limit=100')
    ).items.filter((r) => r.data.externalNumber === `luma-ex:${operationId}`),
  ).toHaveLength(1);
  expect(
    (
      await f.call(
        'runs/operations/records/shopify?kind=FulfillmentOrder&limit=100',
      )
    ).items.filter((r) => r.data.order === f.providerOrderId),
  ).toHaveLength(2);
  expect(
    (
      await f.call('runs/operations/records/shopify?kind=Refund&limit=100')
    ).items.filter((r) => r.data.order === f.providerOrderId),
  ).toHaveLength(1);
  await f.call('runs/operations/control', {
    action: 'fault',
    rule: {
      instance: 'jtl',
      operation: 'returns.exchange.reservation.read',
      kind: 'malformed',
      remaining: 1,
    },
  });
  report = await request(`${path}/exchange/complete`, {});
  expect(report).toMatchObject({
    state: 'unresolved',
    ownerId: f.detail.case.openedBy.id,
  });
  expect((await request(path)).case.state).toBe('open');
  const final = await request(`${path}/exchange/complete`, {});
  expect(final.state).toBe('verified');

  // Every read the verdicts, steps, settlements, waits and audit cite is stored once; each
  // verdict's Wawi and Shopify reads are stored under the exchange operation.
  const reads = await citedReturnReads(f, f.detail.case.id);
  expect(reads.stored.map((row) => row.id)).toEqual(reads.cited);
  expect(reads.cited).toEqual(expect.arrayContaining(final.evidenceRefs));
  const verdict = reads.stored.filter((row) =>
    final.evidenceRefs.includes(row.id),
  );
  expect(verdict.map((row) => row.document.source.provider).sort()).toEqual(
    expect.arrayContaining(['jtl', 'shopify']),
  );
  for (const row of verdict.filter((r) => r.purpose === 'completion'))
    expect(row).toMatchObject({
      subject_id: operationId,
      document: { completeness: 'complete' },
    });
  expect(verdict.some((row) => row.purpose === 'completion')).toBe(true);
  const history = (await request(path)).history.map((e) => e.kind);
  expect(history.filter((k) => k === 'exchange_completed')).toHaveLength(2);
  expect(history.filter((k) => k === 'exchange_reopened')).toHaveLength(1);
  const membership = (
    await request('/members', undefined, f.approver)
  ).items.find((m) => m.userId === f.manifest.operatorId);
  const role = await f.pilot.app.inject({
    method: 'POST',
    url: `${f.root}/roles`,
    headers: {
      cookie: f.approver,
      origin: 'http://127.0.0.1:3000',
      'x-command-id': randomUUID(),
    },
    payload: {
      name: 'Read-only return completion',
      description: '',
      permissions: ['returns.read'],
    },
  });
  expect(role.statusCode, role.body).toBe(201);
  const changed = await f.pilot.app.inject({
    method: 'PATCH',
    url: `${f.root}/members/${membership.id}`,
    headers: { cookie: f.approver, origin: 'http://127.0.0.1:3000' },
    payload: { roleId: role.json().id },
  });
  expect(changed.statusCode, changed.body).toBe(200);
  await request(`${path}/exchange/complete`, {}, f.requester, 403);
});
