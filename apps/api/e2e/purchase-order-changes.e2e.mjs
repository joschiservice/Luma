import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createObservability } from '@luma/platform/composition';
import { expect, it } from 'vitest';

import { setupSimulator } from './simulator-fixture.mjs';

const origin = 'http://127.0.0.1:3000';
const flags = {
  'purchasing-order-changes': true,
  'supplier-purchasing-terms': true,
};
it('applies one approved JTL position revision, preserves earlier lines and survives restart without repeating it', async (t) => {
  const f = await setupSimulator(t, {
    historyDays: 1,
    featureFlagOverrides: flags,
    observability: createObservability({
      environment: 'test',
      release: 'test',
      sampleRate: 0,
      featureFlagOverrides: flags,
    }),
  });
  await f.pilot.observe();
  const org = f.manifest.organizationId,
    root = `/v1/organizations/${org}/procurement`;
  const login = async (email) => {
    const response = await f.pilot.app.inject({
      method: 'POST',
      url: '/auth/sign-in/email',
      headers: { origin },
      payload: { email, password: f.password },
    });
    assert.equal(response.statusCode, 200, response.body);

    return response.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  };
  let buyer = await login('pilot-operator@example.test'),
    approver = await login('pilot-requester@example.test');
  const call = async (path, body, { cookie = buyer, status = 200 } = {}) => {
    const response = await f.pilot.app.inject({
      method: body ? 'POST' : 'GET',
      url: `${root}${path}`,
      headers: { cookie, origin },
      ...(body ? { payload: body } : {}),
    });
    assert.equal(response.statusCode, status, response.body);

    return response.json();
  };
  await f.call('runs/operations/control', {
    action: 'command',
    instance: 'jtl',
    command: { kind: 'supplier-profile', supplierId: '1', profile: 'silent' },
  });
  const supplier = await call('/suppliers', {
    id: randomUUID(),
    name: 'Revision supplier',
    externalReferences: [],
  });
  const connectionId = f.manifest.connections.jtl;
  await call(`/suppliers/${supplier.id}/link`, {
    expectedRevision: 1,
    link: { connectionId, externalId: '1', scopeKey: '' },
    confirmationHours: 48,
  });
  const sku = (
    await f.db.owner.query(
      "SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource='sku' AND external_id='2'",
      [org, connectionId],
    )
  ).rows[0]?.canonical_id;
  assert.ok(sku);
  await f.call('runs/operations/control', {
    action: 'command',
    instance: 'jtl',
    command: {
      kind: 'supplier-terms',
      itemId: '2',
      supplierId: '1',
      netPrice: 3.5,
      packSize: 4,
    },
  });
  await f.pilot.observe();
  const terms = () =>
    call(`/supplier-terms?supplierId=${supplier.id}&skuId=${sku}`);
  const firstTerms = (await terms()).items[0];
  expect(firstTerms.observed.source).toBe('provider');
  await call('/supplier-terms', {
    id: randomUUID(),
    supplierId: supplier.id,
    skuId: sku,
    expectedRevision: firstTerms.revision,
    reason: 'Supplier agreed a six-unit ordering pack',
    values: { packSize: 6 },
  });
  await f.call('runs/operations/control', {
    action: 'command',
    instance: 'jtl',
    command: {
      kind: 'supplier-terms',
      itemId: '2',
      supplierId: '1',
      netPrice: 4.25,
      packSize: 8,
    },
  });
  await f.pilot.observe();
  const changedTerms = (await terms()).items[0];
  expect(changedTerms.effective.packSize).toBe(6);
  expect(changedTerms.observed.values.packSize).toBe(8);
  expect(changedTerms.history.length).toBeGreaterThanOrEqual(3);

  const lineId = randomUUID(),
    order = await call('/purchase-orders', {
      id: randomUUID(),
      supplierId: supplier.id,
      reference: 'PO-REVISION',
      lines: [
        {
          id: lineId,
          sku,
          description: 'Cotton tote',
          quantity: 10,
          unit: 'each',
        },
      ],
    });
  const submitted = await call(`/purchase-orders/${order.id}/submissions`, {
    id: randomUUID(),
    requestedDeliveryDate: new Date(Date.now() + 86400000 * 7)
      .toISOString()
      .slice(0, 10),
  });
  expect(submitted.state).toBe('approval_required');
  const placed = await call(
    `/submissions/${submitted.id}/decision`,
    { decisionId: submitted.decisionId, outcome: 'approved' },
    { cookie: approver },
  );
  expect(placed.state).toBe('submitted');
  const before = await call(`/purchase-orders/${order.id}/record`);
  await call(
    `/purchase-orders/${order.id}/transitions`,
    {
      id: randomUUID(),
      expectedRevision: before.order.revision,
      status: 'cancelled',
      reason: 'Do not treat local status as source cancellation',
    },
    { status: 409 },
  );
  const request = {
    id: randomUUID(),
    expectedRevision: before.order.revision,
    reason: 'Buyer agreed to receive six units',
    operation: { kind: 'update_line', lineId, quantity: 6 },
  };
  const change = await call(`/purchase-orders/${order.id}/changes`, request);
  expect(change.state, JSON.stringify(change)).toBe('approval_required');
  expect(change.affectsCommitments).toBe(false);
  const list = await call(`/purchase-orders/${order.id}/changes`);
  expect(list.changes[0].canApprove).toBe(false);
  expect(list.cancelAvailable).toBe(false);
  await call(
    `/order-changes/${change.id}/decision`,
    { outcome: 'approved' },
    { status: 403 },
  );
  const revised = await call(
    `/order-changes/${change.id}/decision`,
    { outcome: 'approved' },
    { cookie: approver },
  );
  expect(revised.state).toBe('verified');
  const after = await call(`/purchase-orders/${order.id}/record`);
  expect(after.order.lines[0].quantity).toBe(6);
  expect(after.order.revision).toBe(before.order.revision + 1);
  expect(
    (await call(`/purchase-orders/${order.id}/changes`)).revisions.map(
      (v) => v.order.lines[0].quantity,
    ),
  ).toEqual([10, 6]);
  f.pilot = await f.restartPilot();
  buyer = await login('pilot-operator@example.test');
  expect((await call(`/order-changes/${change.id}/send`, {})).state).toBe(
    'verified',
  );
  expect((await call(`/purchase-orders/${order.id}/changes`, request)).id).toBe(
    change.id,
  );
  const history = (
    await f.call('runs/operations/records/jtl?kind=purchase-order&limit=100')
  ).items.filter((item) =>
    String(item.data.internalComment ?? '').includes(order.id),
  );
  expect(history).toHaveLength(1);
  expect(history[0].data.lineItems[0].quantity).toBe(6);
  const attempts = await f.db.owner.query(
    'SELECT count(*)::int AS n FROM executed_actions WHERE tenant_id=$1 AND proposal_id=$2',
    [
      org,
      (
        await f.db.owner.query(
          'SELECT document FROM procurement_order_changes WHERE tenant_id=$1 AND id=$2',
          [org, change.id],
        )
      ).rows[0].document.actionId,
    ],
  );
  expect(attempts.rows[0].n).toBe(1);
  await call(
    `/purchase-orders/${order.id}/changes`,
    {
      id: randomUUID(),
      expectedRevision: after.order.revision,
      reason: 'Unsupported cancellation',
      operation: { kind: 'cancel' },
    },
    { status: 409 },
  );
});
