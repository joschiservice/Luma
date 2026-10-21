import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { inboxFixture } from './inbox-fixture.mjs';
import { purchasingWorker } from './purchasing-worker-fixture.mjs';
import {
  citedReturnReads,
  providerWrites,
  settlementFixture,
} from './return-settlement-fixture.mjs';
import { setupSimulator } from './simulator-fixture.mjs';
import {
  addAdmin,
  dueReturnWrite,
  evidence,
  expectNoWriteReceipt,
  loseResponse,
  restart,
  withRequesterSuspended,
} from './worker-effects-fixture.mjs';

// Background workers compose the same service graph as the API through applicationOptionsFor.
// Each journey has a separate worker process execute or reconcile one provider write, restarts
// it, and checks that the write happened once, under the original approval, and was verified by
// an independent read.

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

/**
 * Every purchasing-system read the action's verifications and the order's submission audit cite,
 * with the stored procurement evidence each ID resolves to.
 */
async function citedPurchasingReads(f, proposalId, purchaseOrderId) {
  const org = f.manifest.organizationId;
  const refs = await f.db.owner.query(
    `SELECT jsonb_array_elements_text(document->'attempt'->'verification'->'observationRefs') AS id
       FROM executed_actions WHERE tenant_id=$1 AND proposal_id=$2
     UNION SELECT jsonb_array_elements_text(document->'result'->'observationRefs')
       FROM execution_verifications WHERE tenant_id=$1 AND proposal_id=$2
     UNION SELECT jsonb_array_elements_text(document->'evidenceRefs')
       FROM audit_entries WHERE tenant_id=$1 AND proposal_id=$3
        AND document->>'eventType'='purchase_order.submitted'`,
    [org, proposalId, purchaseOrderId],
  );
  // Procurement audit entries also name the order itself.
  const cited = refs.rows
    .map((row) => row.id)
    .filter((id) => id !== purchaseOrderId);
  const stored = await f.db.owner.query(
    'SELECT id,purpose,subject_id,document FROM procurement_read_evidence WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
    [org, cited],
  );

  return { cited, stored: stored.rows };
}

it('places an approved purchase order from the worker once and verifies it after a lost response and restart', async (t) => {
  const f = await setupSimulator(t);
  await f.pilot.observe();
  const org = f.manifest.organizationId;
  const buyer = await login(f, 'pilot-operator@example.test');
  const approver = await login(f, 'pilot-requester@example.test');
  await addAdmin(f);
  const call = async (path, body, { cookie = buyer, status = 200 } = {}) => {
    const response = await f.pilot.app.inject({
      method: body ? 'POST' : 'GET',
      url: `/v1/organizations/${org}/procurement${path}`,
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
    name: 'Nordwind Textil',
    externalReferences: [],
  });
  const jtl = f.manifest.connections.jtl;
  const nordwind = (
    await call(`/purchasing-connections/${jtl}/suppliers`)
  ).items.find((s) => s.externalId === '1');
  await call(`/suppliers/${supplier.id}/link`, {
    expectedRevision: 1,
    link: { connectionId: jtl, externalId: '1', scopeKey: nordwind.scopeKey },
    confirmationHours: 48,
  });
  const sku = (
    await f.db.owner.query(
      "SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource='sku' AND external_id='2'",
      [org, jtl],
    )
  ).rows[0].canonical_id;
  const order = await call('/purchase-orders', {
    id: randomUUID(),
    supplierId: supplier.id,
    reference: 'PO-WORKER-1',
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
  const placed = async () =>
    (
      await f.call('runs/operations/records/jtl?kind=purchase-order&limit=100')
    ).items.filter((o) =>
      String(o.data.internalComment ?? '').includes(order.id),
    );
  const requested = await call(`/purchase-orders/${order.id}/submissions`, {
    id: randomUUID(),
    requestedDeliveryDate: new Date(Date.now() + 7 * 86_400_000)
      .toISOString()
      .slice(0, 10),
  });
  expect(requested.state).toBe('approval_required');
  let worker = await purchasingWorker(t, f.purchasingWorkerConfiguration());

  const approved = await withRequesterSuspended(f, f.manifest.operatorId, () =>
    call(
      `/submissions/${requested.id}/decision`,
      { decisionId: requested.decisionId, outcome: 'approved' },
      { cookie: approver },
    ),
  );
  expect(approved.state).toBe('approved');
  expect(await placed()).toHaveLength(0);

  // The worker sends the approved order as its requester; the response is lost after JTL commits.
  await loseResponse(f, 'jtl', 'purchase-orders.submit');
  await worker.pass();
  expect(await placed()).toHaveLength(1);
  let record = await call(`/purchase-orders/${order.id}/record`);
  expect(record.submission.state).toBe('uncertain');

  // A restarted worker only reads: verification finds the order and nothing is sent again.
  worker = await restart(t, f, worker, (next) => next.pass());
  await worker.pass();
  expect(await placed()).toHaveLength(1);
  record = await call(`/purchase-orders/${order.id}/record`);
  expect(record.submission.state).toBe('submitted');
  expect(record.stage).toBe('awaiting_confirmation');
  expect((await call(`/submissions/${requested.id}/send`, {})).state).toBe(
    'submitted',
  );
  expect(await placed()).toHaveLength(1);

  const found = await evidence(f, requested.actionId);
  expect(found.executions).toHaveLength(1);
  expect(found.executions[0].state).toBe('succeeded');
  expect(found.executions[0].document.attempt).toMatchObject({
    requestedBy: f.manifest.operatorId,
    businessOutcome: 'satisfied',
    verification: { outcome: 'passed' },
  });
  expect(found.approvers).toEqual([f.manifest.requesterId]);
  expect(found).toMatchObject({ prepared: 1, completed: 1 });
  expect(found.reconciled).toBeGreaterThan(0);
  await expectNoWriteReceipt(f, requested.actionId);

  // Every read the verification and submission audit cite resolves to stored evidence.
  const reads = await citedPurchasingReads(f, requested.actionId, order.id);
  expect(reads.cited.length).toBeGreaterThan(0);
  expect(reads.stored.map((row) => row.id).sort()).toEqual(
    [...reads.cited].sort(),
  );
  for (const row of reads.stored)
    expect(row).toMatchObject({
      purpose: 'submission',
      subject_id: requested.id,
      document: {
        purchaseOrderId: order.id,
        source: {
          provider: 'jtl',
          connectionId: jtl,
          resource: 'purchase_order',
        },
        completeness: 'complete',
        data: { lumaOrderId: order.id },
      },
    });
});

it('sends an approved reply from the worker once and confirms it by reading the thread after a restart', async (t) => {
  const f = await inboxFixture(t);
  await f.join('Worker', 'admin');
  const incident = await f.scenario('customer-delay-mail');
  const orderName = incident.resources.find(
    (item) => item.kind === 'Order',
  ).label;
  let summary;
  await f.readUntil(async () => {
    summary = (await f.threads()).items.find((item) =>
      item.subject.includes(orderName),
    );

    return summary;
  }, 'the customer thread');
  const draft = await f.messaging(`/threads/${summary.id}/drafts`, {
    id: randomUUID(),
  });
  await f.request(
    `/messaging/outbound/${draft.id}`,
    {
      expectedRevision: draft.revision,
      to: draft.to.map((item) => item.address),
      cc: [],
      subject: draft.subject,
      text: 'We will ship 2 units on 2026-10-20. Thank you for your patience.',
    },
    { method: 'PUT' },
  );
  const requested = await f.messaging(`/outbound/${draft.id}/request`, {
    id: randomUUID(),
  });
  expect(requested.state).toBe('approval_required');
  const sent = async () =>
    (await f.mailbox()).filter(
      (message) => message.messageId === `luma.${draft.id}@luma-goods.example`,
    );
  const outbound = async () =>
    (
      await f.db.owner.query(
        'SELECT state,action_id FROM messaging_outbound WHERE tenant_id=$1 AND id=$2',
        [f.org, draft.id],
      )
    ).rows[0];
  let worker = await purchasingWorker(t, f.purchasingWorkerConfiguration());

  const approved = await withRequesterSuspended(f, f.manifest.operatorId, () =>
    f.messaging(
      `/outbound/${draft.id}/decision`,
      { decisionId: requested.decisionId, outcome: 'approved' },
      { cookie: f.owner },
    ),
  );
  expect(approved.state).toBe('approved');
  expect(await sent()).toEqual([]);

  // The worker sends as the requester; the mailbox accepts the message but the response is lost.
  await loseResponse(f, 'gmail', 'messages.send');
  await worker.pass();
  expect(await sent()).toHaveLength(1);
  expect((await outbound()).state).toBe('uncertain');

  // A restarted worker reads the thread instead of sending again.
  worker = await restart(t, f, worker, (next) => next.pass());
  await worker.pass();
  expect(await sent()).toHaveLength(1);
  const settled = await outbound();
  expect(settled.state).toBe('sent');

  const found = await evidence(f, settled.action_id);
  expect(found.executions).toHaveLength(1);
  expect(found.executions[0].state).toBe('succeeded');
  expect(found.executions[0].document.attempt).toMatchObject({
    requestedBy: f.manifest.operatorId,
    verification: { outcome: 'passed' },
  });
  expect(found.approvers).toEqual([f.manifest.requesterId]);
  expect(found).toMatchObject({ prepared: 1, completed: 1 });
  expect(found.reconciled).toBeGreaterThan(0);
  await expectNoWriteReceipt(f, settled.action_id);
});

it('creates an approved return from the sync worker once and records it after a lost response and restart', async (t) => {
  const f = await settlementFixture(t, { prepare: 'opened' });
  await addAdmin(f);
  const requested = await f.request(`${f.path}/creations`, {
    id: randomUUID(),
    warehouse: { externalId: 'shopify', scopeKey: '' },
    reason: { externalId: 'SIZE_TOO_SMALL', scopeKey: '' },
  });
  const creation = requested.creation;
  expect(creation.state).toBe('approval_required');
  const returns = async () =>
    (
      await f.call('runs/operations/records/shopify?kind=Return&limit=100')
    ).items.filter((r) => r.data.order === f.providerOrderId);
  const current = async () => (await f.request(f.path)).creation;
  let worker = await purchasingWorker(t, f.purchasingWorkerConfiguration());

  // The API records the approval but cannot send as the requester, as after a crash.
  const approved = await withRequesterSuspended(f, f.manifest.operatorId, () =>
    f.request(
      `${f.path}/creations/${creation.id}/decision`,
      { decisionId: creation.decisionId, outcome: 'approved' },
      f.approver,
    ),
  );
  expect(approved.creation.state).toBe('approved');
  expect(await returns()).toHaveLength(0);

  // The worker creates the return as the requester; the response is lost after Shopify commits.
  await loseResponse(f, 'shopify', 'returns.create');
  await worker.returnWrites();
  expect(await returns()).toHaveLength(1);
  expect((await current()).state).toBe('uncertain');

  // A restarted worker reads the store instead of creating a second return.
  await dueReturnWrite(f, 'orders_return_creations', creation.id);
  worker = await restart(t, f, worker, (next) => next.returnWrites());
  expect(await returns()).toHaveLength(1);
  expect(await current()).toMatchObject({
    state: 'created',
    externalReturn: { externalId: expect.any(String) },
  });
  await worker.returnWrites();
  expect(await returns()).toHaveLength(1);

  const actionId = (
    await f.db.owner.query(
      "SELECT document->>'actionId' AS id FROM orders_return_creations WHERE tenant_id=$1 AND id=$2",
      [f.org, creation.id],
    )
  ).rows[0].id;
  const found = await evidence(f, actionId);
  expect(found.executions).toHaveLength(1);
  expect(found.executions[0].state).toBe('succeeded');
  expect(found.executions[0].document.attempt).toMatchObject({
    requestedBy: f.manifest.operatorId,
    verification: { outcome: 'passed' },
  });
  expect(found.approvers).toEqual([f.manifest.requesterId]);
  expect(found).toMatchObject({ prepared: 1, completed: 1 });
  expect(found.reconciled).toBeGreaterThan(0);
  await expectNoWriteReceipt(f, actionId);
  // Shopify received one return creation, the one whose response was lost.
  await expect
    .poll(() => providerWrites(f, 'shopify', 'returns.create'), {
      timeout: 5_000,
    })
    .toEqual(['response-loss']);

  // Every read the verifications and the creation audit cite resolves to the stored return read.
  const reads = await citedReturnReads(f, f.detail.case.id);
  expect(reads.cited.length).toBeGreaterThan(0);
  expect(reads.stored.map((row) => row.id).sort()).toEqual(
    [...reads.cited].sort(),
  );
  const created = await current();
  for (const row of reads.stored)
    expect(row).toMatchObject({
      purpose: 'creation',
      subject_id: creation.id,
      document: {
        caseId: f.detail.case.id,
        source: {
          provider: 'shopify',
          connectionId: f.connectionId,
          resource: 'return',
          externalId: created.externalReturn.externalId,
        },
        completeness: 'complete',
        data: { lumaCaseId: f.detail.case.id },
      },
    });
});
