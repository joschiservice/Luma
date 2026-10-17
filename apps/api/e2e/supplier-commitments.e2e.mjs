import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { setupSimulator } from './simulator-fixture.mjs';
import { expectStoredWriteReceipts } from './write-receipts-fixture.mjs';

const origin = 'http://127.0.0.1:3000';

/** Signs in a seeded pilot user and returns their session cookie. */
async function login(f, email) {
  const response = await f.pilot.app.inject({
    method: 'POST',
    url: '/auth/sign-in/email',
    headers: { origin },
    payload: { email, password: f.password },
  });
  assert.equal(response.statusCode, 200, response.body);

  return []
    .concat(response.headers['set-cookie'])
    .map((v) => v.split(';')[0])
    .join('; ');
}

it('places an approved order once, follows supplier confirmation and receipt, and keeps evidence', async (t) => {
  const f = await setupSimulator(t);
  await f.pilot.observe();
  const org = f.manifest.organizationId;
  const root = `/v1/organizations/${org}/procurement`;
  const buyer = await login(f, 'pilot-operator@example.test');
  const approver = await login(f, 'pilot-requester@example.test');
  const request = async (url, body, { cookie = buyer, status = 200 } = {}) => {
    const response = await f.pilot.app.inject({
      method: body ? 'POST' : 'GET',
      url,
      headers: { cookie, origin },
      ...(body ? { payload: body } : {}),
    });
    assert.equal(response.statusCode, status, response.body);

    return response.json();
  };
  const call = (path, body, options) =>
    request(`${root}${path}`, body, options);
  const simulator = (command) =>
    f.call('runs/operations/control', {
      action: 'command',
      instance: 'jtl',
      command,
    });
  // Drive the supplier explicitly instead of the default automatic profile.
  await simulator({
    kind: 'supplier-profile',
    supplierId: '1',
    profile: 'silent',
  });

  const supplier = await call('/suppliers', {
    id: randomUUID(),
    name: 'Nordwind Textil',
    externalReferences: [],
  });
  const connections = await call('/purchasing-connections');
  const jtl = connections.find((c) => c.id === f.manifest.connections.jtl);
  expect(jtl).toMatchObject({ canSubmit: true, canReadOrders: true });
  const suppliers = await call(`/purchasing-connections/${jtl.id}/suppliers`);
  const nordwind = suppliers.items.find((s) => s.externalId === '1');
  expect(nordwind?.name).toBe('Nordwind Textil GmbH');
  await call(`/suppliers/${supplier.id}/link`, {
    expectedRevision: 1,
    link: {
      connectionId: jtl.id,
      externalId: '1',
      scopeKey: nordwind.scopeKey,
    },
    confirmationHours: 48,
  });
  // A stale revision is rejected.
  await call(
    `/suppliers/${supplier.id}/link`,
    { expectedRevision: 1, link: null, confirmationHours: 24 },
    { status: 409 },
  );

  const sku = (
    await f.db.owner.query(
      `SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2
       AND resource='sku' AND external_id='2'`,
      [org, jtl.id],
    )
  ).rows[0]?.canonical_id;
  assert.ok(
    sku,
    JSON.stringify(
      (
        await f.db.owner.query(
          `SELECT connection_id,resource,external_id,scope_key FROM connector_source_mappings WHERE tenant_id=$1`,
          [org],
        )
      ).rows,
    ),
  );
  const order = await call('/purchase-orders', {
    id: randomUUID(),
    supplierId: supplier.id,
    reference: 'PO-SUP-1',
    lines: [
      {
        id: randomUUID(),
        sku,
        description: 'Cotton tote',
        quantity: 10,
        unit: 'each',
      },
    ],
  });
  let record = await call(`/purchase-orders/${order.id}/record`);
  expect(record.readiness).toMatchObject({ ready: true, blockers: [] });
  expect(record.stage).toBe('draft');
  expect(record.progress.milestones.map((m) => [m.key, m.state])).toEqual([
    ['drafted', 'complete'],
    ['submitted', 'not_started'],
    ['confirmed', 'not_started'],
    ['received', 'not_started'],
  ]);

  const requestedDeliveryDate = new Date(Date.now() + 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const settings = await request(
    `/v1/organizations/${org}/settings`,
    undefined,
    { cookie: approver },
  );
  const writeMode = async (mode, revision) => {
    const response = await f.pilot.app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${org}/settings/write-mode`,
      headers: { cookie: approver, origin },
      payload: { commandId: randomUUID(), writeMode: mode, revision },
    });
    expect(response.statusCode, response.body).toBe(200);

    return response.json();
  };
  const observing = await writeMode(
    'observe_only',
    settings.workspace.revision,
  );
  const observedRequest = { id: randomUUID(), requestedDeliveryDate };
  const observed = await call(
    `/purchase-orders/${order.id}/submissions`,
    observedRequest,
  );
  expect(observed).toMatchObject({
    state: 'not_executed',
    observeOnly: true,
    canApprove: false,
    canSend: false,
    canCheck: false,
    failure: null,
  });
  await f.pilot.followUp();
  expect(
    await call(`/purchase-orders/${order.id}/submissions`, observedRequest),
  ).toMatchObject({ id: observed.id, state: 'not_executed' });
  expect((await call(`/purchase-orders/${order.id}/record`)).stage).toBe(
    'draft',
  );
  expect(
    (
      await f.db.owner.query(
        'SELECT count(*)::int AS n FROM executed_actions WHERE tenant_id=$1 AND proposal_id=$2',
        [org, observed.actionId],
      )
    ).rows[0].n,
  ).toBe(0);
  await writeMode('writes_enabled', observing.workspace.revision);
  // Enabling writes requires a fresh submission; the observed request stays terminal.
  expect(
    await call(`/purchase-orders/${order.id}/submissions`, observedRequest),
  ).toMatchObject({ state: 'not_executed' });
  const submissionRequest = { id: randomUUID(), requestedDeliveryDate };
  const attempts = await Promise.allSettled([
    call(`/purchase-orders/${order.id}/submissions`, submissionRequest),
    call(`/purchase-orders/${order.id}/submissions`, submissionRequest),
  ]);
  const successful = attempts.flatMap((attempt) =>
    attempt.status === 'fulfilled' ? [attempt.value] : [],
  );
  expect(successful.length).toBeGreaterThan(0);
  const [requested, retried] = successful;
  expect(requested.state, JSON.stringify(requested)).toBe('approval_required');
  if (retried) expect(retried.id).toBe(requested.id);
  expect(requested.canApprove).toBe(false);
  // A second live submission for the same order is refused.
  await call(
    `/purchase-orders/${order.id}/submissions`,
    { id: randomUUID(), requestedDeliveryDate },
    { status: 409 },
  );
  const queue = await request(
    `/v1/organizations/${org}/decisions?view=all&limit=50`,
    undefined,
    { cookie: approver },
  );
  expect(
    queue.items.find(
      (i) => i.id === `supplier:submission_approval:${requested.id}`,
    ),
  ).toMatchObject({ response: 'decide', kind: 'supplier_commitment' });
  // The requester cannot approve their own submission.
  await call(
    `/submissions/${requested.id}/decision`,
    { decisionId: requested.decisionId, outcome: 'approved' },
    { status: 409 },
  );
  const approved = await call(
    `/submissions/${requested.id}/decision`,
    { decisionId: requested.decisionId, outcome: 'approved' },
    { cookie: approver },
  );
  expect(approved.state).toBe('submitted');
  const historical = await request(
    `/v1/organizations/${org}/decisions/${encodeURIComponent(`supplier:submission_approval:${requested.id}`)}`,
    undefined,
    { cookie: approver },
  );
  expect(historical.outcome).toMatchObject({
    state: 'approved',
    next: 'verified',
    purchaseOrderId: order.id,
  });

  expect(approved.externalOrder?.externalId).toBeTruthy();
  const purchaseOrders = (
    await f.call('runs/operations/records/jtl?kind=purchase-order&limit=100')
  ).items.map((item) => item.data);
  const placed = purchaseOrders.filter((o) =>
    String(o.internalComment ?? '').includes(order.id),
  );
  expect(placed).toHaveLength(1);

  // The attempt cites one stored write receipt naming the JTL order it created.
  const [attempt] = await expectStoredWriteReceipts(f.db.owner, org, [
    requested.actionId,
  ]);
  expect(attempt.stored).toEqual([
    expect.objectContaining({
      owner: 'procurement',
      document: expect.objectContaining({
        purchaseOrderId: order.id,
        purpose: 'submission',
        subjectId: requested.id,
        source: { provider: 'jtl', connectionId: f.manifest.connections.jtl },
        records: [
          {
            resource: 'purchase_order',
            externalId: approved.externalOrder.externalId,
          },
        ],
      }),
    }),
  ]);

  record = await call(`/purchase-orders/${order.id}/record`);
  expect(record.order.status).toBe('open');
  expect(record.stage).toBe('awaiting_confirmation');
  expect(record.progress.next.owner).toBe('supplier');

  // The supplier confirms fewer units and a later date in JTL.
  const externalId = approved.externalOrder.externalId;
  const lineItemId = String(Number(externalId) * 1000 + 1);
  const later = new Date(Date.parse(requestedDeliveryDate) + 3 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  await simulator({
    kind: 'purchase-order-confirm',
    orderId: externalId,
    lines: [{ lineItemId, quantity: 6, deliveryDate: later }],
  });
  await f.pilot.followUp();
  await f.pilot.followUp();
  record = await call(`/purchase-orders/${order.id}/record`);
  expect(record.stage).toBe('changed');
  const acknowledgments = await f.db.owner.query(
    "SELECT document FROM workflow_events WHERE tenant_id=$1 AND event_type='supplier.acknowledged' AND correlation_key=$2",
    [org, order.id],
  );
  expect(acknowledgments.rows.length).toBeGreaterThan(0);
  for (const { document: event } of acknowledgments.rows) {
    expect(event.values).toEqual({ acknowledged: true });
    expect(event.evidenceRefs).toEqual([
      `procurement_observation:${event.sourceId.slice('supplier-acknowledgment:'.length)}`,
    ]);
  }
  expect(
    record.commitments.filter((c) => c.source.kind === 'purchasing_system'),
  ).toHaveLength(2);
  const changes = record.progress.attention.filter(
    (a) => a.kind === 'commitment_changed',
  );
  expect(changes.length).toBe(2);
  for (const change of changes)
    await call(`/purchase-orders/${order.id}/follow-ups`, {
      id: randomUUID(),
      key: change.key,
      response: 'accepted',
      note: 'Supplier is short on stock',
      nextCheckAt: null,
    });

  // The same supplier message is recorded once; without a model it waits for manual facts.
  const message = {
    id: randomUUID(),
    from: 'orders@nordwind-textil.example',
    subject: `Re: ${order.id}`,
    body: 'We can deliver 6 pieces on the confirmed date.',
    receivedAt: new Date().toISOString(),
    messageId: '<confirm-1@nordwind>',
  };
  const first = await call(`/purchase-orders/${order.id}/messages`, message);
  const again = await call(`/purchase-orders/${order.id}/messages`, {
    ...message,
    id: randomUUID(),
  });
  expect(first.duplicate).toBe(false);
  expect(again).toEqual({
    communicationId: first.communicationId,
    duplicate: true,
  });
  record = await call(`/purchase-orders/${order.id}/record`);
  expect(record.communications).toHaveLength(1);
  expect(record.extractions[0]).toMatchObject({ state: 'unavailable' });
  // Receipt can never be recorded from a message.
  await call(
    `/purchase-orders/${order.id}/commitments`,
    { id: randomUUID(), kind: 'received', quantity: 6 },
    { status: 400 },
  );

  await simulator({
    kind: 'purchase-order-receive',
    orderId: externalId,
    lines: [{ lineItemId, quantity: 4 }],
  });
  await f.pilot.followUp();
  record = await call(`/purchase-orders/${order.id}/record`);
  expect(record.stage).toBe('partially_received');
  expect(record.progress.lines[0]).toMatchObject({
    received: 4,
    outstanding: 2,
  });
  expect(
    record.progress.milestones.find((m) => m.key === 'received')?.state,
  ).toBe('partial');

  await simulator({
    kind: 'purchase-order-receive',
    orderId: externalId,
    lines: [{ lineItemId, quantity: 2 }],
  });
  await f.pilot.followUp();
  record = await call(`/purchase-orders/${order.id}/record`);
  expect(record.stage).toBe('received');
  expect(record.progress.next.title).toBe('Close the order');
  const settled = await f.db.owner.query(
    'SELECT settled FROM procurement_submissions WHERE tenant_id=$1 AND id=$2',
    [org, requested.id],
  );
  expect(settled.rows[0].settled).toBe(true);
  // Repeated reads do not duplicate commitments.
  await call(`/purchase-orders/${order.id}/refresh`, {});
  const final = await call(`/purchase-orders/${order.id}/record`);
  expect(final.commitments.length).toBe(record.commitments.length);

  const supplierRecord = await call(`/suppliers/${supplier.id}`);
  expect(supplierRecord.orders[0]).toMatchObject({ stage: 'received' });
  const context = await call(`/purchase-orders/${order.id}/context`);
  expect(context.lines[0]).toMatchObject({ skuId: sku });
  expect(context.lines[0].positions.length).toBeGreaterThan(0);
  const progress = await call('/purchase-orders/progress');
  expect(progress.items.find((i) => i.id === order.id)?.stage).toBe('received');
});
