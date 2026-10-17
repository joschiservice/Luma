import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  citedReturnReads,
  returnWriteReceipts,
  settlementFixture,
} from './return-settlement-fixture.mjs';

it('separately verifies resale stock and a lost-response refund without restocking damaged units or duplicating money', async (t) => {
  const f = await settlementFixture(t);
  const {
    root,
    requester,
    approver,
    request,
    command,
    providerOrderId,
    detail,
    path,
    lines,
    evidence,
  } = f;
  const choices = await request(`${path}/settlements`);
  expect(choices.targets.length).toBeGreaterThan(0);
  const target = choices.targets.find(
    (t) => t.warehouse.externalId !== 'all-warehouses',
  );
  expect(target).toBeTruthy();
  const stock = await request(`${path}/settlements`, {
    id: randomUUID(),
    kind: 'restock',
    targetId: target.id,
  });
  expect(stock).toMatchObject({
    state: 'approval_required',
    sent: false,
    plan: { kind: 'restock', quantity: 1 },
    proof: null,
  });
  await request(
    `${path}/settlements/${stock.id}/decision`,
    { decisionId: stock.decisionId, outcome: 'approved' },
    requester,
    409,
  );
  await f.call('runs/operations/control', {
    action: 'fault',
    rule: {
      instance: 'jtl',
      operation: 'returns.restock',
      kind: 'response-loss',
      remaining: 1,
    },
  });
  const restocked = await request(
    `${path}/settlements/${stock.id}/decision`,
    { decisionId: stock.decisionId, outcome: 'approved' },
    approver,
  );
  expect(restocked).toMatchObject({
    state: 'verified',
    sent: true,
    proof: { outcome: 'passed', payment: null },
  });
  await request(`${path}/settlements/${stock.id}/send`, {});
  await request(
    `${path}/settlements`,
    { id: randomUUID(), kind: 'restock', targetId: target.id },
    requester,
    409,
  );
  const stockRecords = (
    await f.call('runs/operations/records/jtl?kind=stock-change&limit=100')
  ).items.filter((r) => r.data.comment === `luma-rs:${stock.id}`);
  expect(stockRecords).toHaveLength(1);
  expect(stockRecords[0].data.quantity).toBe(1);
  // Physical facts cannot be rewritten after dispatch, even through the API.
  await request(
    `${path}/receipt`,
    {
      commandId: randomUUID(),
      expectedRevision: detail.case.revision,
      lines: lines.map((l) => ({ orderLineId: l.orderLineId, received: 0 })),
      evidence,
    },
    requester,
    409,
  );
  const refundBody = { id: randomUUID(), kind: 'refund' };
  const refund = await request(`${path}/settlements`, refundBody, approver);
  expect(refund).toMatchObject({
    state: 'approval_required',
    sent: false,
    proof: null,
    plan: { kind: 'refund', lines: [{ quantity: 2 }] },
  });
  expect((await request(`${path}/settlements`, refundBody, approver)).id).toBe(
    refund.id,
  );
  // Approval authority does not imply the installed app's money permission.
  const members = await request('/members', undefined, approver);
  const membership = members.items.find(
    (m) => m.userId === f.manifest.operatorId,
  );
  const role = await f.pilot.app.inject({
    method: 'POST',
    url: `${root}/roles`,
    headers: {
      cookie: approver,
      origin: 'http://127.0.0.1:3000',
      'x-command-id': randomUUID(),
    },
    payload: {
      name: 'Settlement reviewer without app access',
      description: '',
      permissions: ['returns.read', 'returns.manage', 'decisions.respond'],
    },
  });
  expect(role.statusCode, role.body).toBe(201);

  async function changeRole(roleId) {
    const changed = await f.pilot.app.inject({
      method: 'PATCH',
      url: `${root}/members/${membership.id}`,
      headers: { cookie: approver, origin: 'http://127.0.0.1:3000' },
      payload: { roleId },
    });
    expect(changed.statusCode, changed.body).toBe(200);
  }

  await changeRole(role.json().id);
  expect(
    (await request(`${path}/settlements`)).items.find((a) => a.id === refund.id)
      .canApprove,
  ).toBe(false);
  await request(
    `${path}/settlements/${refund.id}/decision`,
    { decisionId: refund.decisionId, outcome: 'approved' },
    requester,
    409,
  );
  await changeRole('admin');
  await f.call('runs/operations/control', {
    action: 'fault',
    rule: {
      instance: 'shopify',
      operation: 'returns.refund',
      kind: 'response-loss',
      remaining: 1,
    },
  });
  const pending = await request(
    `${path}/settlements/${refund.id}/decision`,
    { decisionId: refund.decisionId, outcome: 'approved' },
    requester,
  );
  expect(pending).toMatchObject({
    state: 'pending',
    sent: true,
    proof: { outcome: 'inconclusive', payment: 'pending' },
  });
  await request(`${path}/settlements/${refund.id}/send`, {});
  await request(`${path}/settlements/${refund.id}/check`, {});
  await request(
    `${path}/settlements`,
    { id: randomUUID(), kind: 'refund' },
    requester,
    409,
  );
  const refunds = () =>
    f.call('runs/operations/records/shopify?kind=Refund&limit=100');
  expect(
    (await refunds()).items.filter(
      (r) => r.data.note === `luma-rs:${refund.id}`,
    ),
  ).toHaveLength(1);
  const refundLineItems = (
    await f.call(
      'runs/operations/records/shopify?kind=RefundLineItem&limit=100',
    )
  ).items;
  const providerRefund = (await refunds()).items.find(
    (r) => r.data.note === `luma-rs:${refund.id}`,
  );
  expect(
    refundLineItems
      .filter((r) => r.data.refund === providerRefund.id)
      .map((r) => [r.data.quantity, r.data.restockType, r.data.restocked]),
  ).toEqual([[2, 'NO_RESTOCK', false]]);
  await command({ kind: 'refund-settle', order: providerOrderId });
  const verified = await request(`${path}/settlements/${refund.id}/check`, {});
  expect(verified).toMatchObject({
    state: 'verified',
    proof: { outcome: 'passed', payment: 'paid' },
  });
  expect(
    (await refunds()).items.filter(
      (r) => r.data.note === `luma-rs:${refund.id}`,
    ),
  ).toHaveLength(1);
  expect((await request(path)).case.state).toBe('open');

  // Every read the stock and refund quotes, proofs, verifications and audit cite is stored once.
  const reads = await citedReturnReads(f, detail.case.id);
  expect(reads.stored.map((row) => row.id)).toEqual(reads.cited);
  const bySubject = (id) => reads.stored.filter((row) => row.subject_id === id);
  expect(bySubject(stock.id).length).toBeGreaterThan(1);
  expect(bySubject(refund.id).length).toBeGreaterThan(1);
  for (const row of bySubject(stock.id))
    expect(row).toMatchObject({
      purpose: 'settlement',
      document: {
        source: { provider: 'jtl', resource: 'sku' },
        completeness: 'complete',
      },
    });
  for (const row of bySubject(refund.id))
    expect(row).toMatchObject({
      purpose: 'settlement',
      document: {
        source: { provider: 'shopify', connectionId: f.connectionId },
        completeness: 'complete',
      },
    });
  // Both responses were lost, so neither write has a receipt and neither attempt cites one.
  const receipts = await returnWriteReceipts(f, detail.case.id);
  expect(receipts.map((attempt) => [attempt.cited, attempt.stored])).toEqual([
    [[], []],
    [[], []],
  ]);
  // The same identity in another tenant cannot reveal or execute this action.
  const other = await f.pilot.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: { cookie: approver, origin: 'http://127.0.0.1:3000' },
    payload: {
      name: 'Settlement isolation',
      slug: `settlement-${randomUUID()}`,
      dataRegion: globalThis.process.env.LUMA_REGION ?? 'AU',
    },
  });
  expect(other.statusCode, other.body).toBe(201);
  const hidden = await f.pilot.app.inject({
    method: 'GET',
    url: `/v1/organizations/${other.json().id}${path}/settlements`,
    headers: { cookie: approver },
  });
  expect(hidden.statusCode, hidden.body).toBe(404);
});
