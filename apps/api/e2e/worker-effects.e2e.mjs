import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { inboxFixture } from './inbox-fixture.mjs';
import { purchasingWorker } from './purchasing-worker-fixture.mjs';
import {
  citedReturnReads,
  settlementFixture,
} from './return-settlement-fixture.mjs';
import { setupSimulator } from './simulator-fixture.mjs';
import { expectStoredWriteReceipts } from './write-receipts-fixture.mjs';

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
 * Adds a third admin, so suspending the requester keeps independent approval and the decision's
 * policy version unchanged.
 */
async function addAdmin(f, ownerCookie) {
  const name = `Worker${randomUUID().slice(0, 8)}`;
  const response = await f.pilot.app.inject({
    method: 'POST',
    url: '/auth/sign-up/email',
    headers: { origin },
    payload: {
      name,
      email: `${name.toLowerCase()}@example.test`,
      dataRegion: globalThis.process.env.LUMA_REGION ?? 'AU',
      password: 'worker-effects-password-123',
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const added = await f.pilot.app.inject({
    method: 'POST',
    url: `/v1/organizations/${f.manifest.organizationId}/members`,
    headers: { cookie: ownerCookie, origin },
    payload: { userId: response.json().user.id, roleId: 'admin' },
  });
  assert.equal(added.statusCode, 201, added.body);
}

/**
 * Suspends the requester while an approval is recorded, so the API cannot send as them and the
 * approved write waits for the background pass, as after an API crash between approval and send.
 */
async function withRequesterSuspended(f, userId, approve) {
  await f.db.owner.query(
    "UPDATE memberships SET status='suspended',suspended_at=now(),suspended_by_kind='customer',suspended_by=$2 WHERE tenant_id=$1 AND user_id=$3",
    [f.manifest.organizationId, f.manifest.requesterId, userId],
  );
  try {
    return await approve();
  } finally {
    await f.db.owner.query(
      "UPDATE memberships SET status='active',suspended_at=NULL,suspended_by_kind=NULL,suspended_by=NULL WHERE tenant_id=$1 AND user_id=$2",
      [f.manifest.organizationId, userId],
    );
  }
}

/** Loses the provider's response after the write commits, once. */
const loseResponse = (f, instance, operation) =>
  f.call('runs/operations/control', {
    action: 'fault',
    rule: { instance, operation, kind: 'response-loss', remaining: 1 },
  });

/** The execution record, approvals and audit trail of one action. */
async function evidence(f, proposalId) {
  const org = f.manifest.organizationId;
  const [executions, approvals, audit] = await Promise.all([
    f.db.owner.query(
      'SELECT state,document FROM executed_actions WHERE tenant_id=$1 AND proposal_id=$2',
      [org, proposalId],
    ),
    f.db.owner.query(
      "SELECT document->>'approverId' AS approver FROM policy_approvals WHERE tenant_id=$1 AND proposal_id=$2",
      [org, proposalId],
    ),
    f.db.owner.query(
      "SELECT document->>'eventType' AS type FROM audit_entries WHERE tenant_id=$1 AND proposal_id=$2",
      [org, proposalId],
    ),
  ]);
  const count = (type) => audit.rows.filter((row) => row.type === type).length;

  return {
    executions: executions.rows,
    approvers: approvals.rows.map((row) => row.approver),
    prepared: count('execution.prepared'),
    completed: count('execution.completed'),
    reconciled: count('execution.reconciled'),
  };
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

/**
 * Asserts that a write whose response was lost has no receipt: nothing is stored for the
 * attempt, and neither the attempt nor its completion audit cites one.
 */
async function expectNoWriteReceipt(f, proposalId) {
  const attempts = await expectStoredWriteReceipts(
    f.db.owner,
    f.manifest.organizationId,
    [proposalId],
  );
  expect(attempts).toHaveLength(1);
  expect(attempts[0]).toMatchObject({ cited: [], stored: [] });
}

/** Restarts the worker process and runs one pass in the new one. */
async function restart(t, f, worker, pass) {
  const pid = worker.pid;
  await worker.stop();
  const next = await purchasingWorker(t, f.purchasingWorkerConfiguration());
  expect(next.pid).not.toBe(pid);
  await pass(next);

  return next;
}

it('places an approved purchase order from the worker once and verifies it after a lost response and restart', async (t) => {
  const f = await setupSimulator(t);
  await f.pilot.observe();
  const org = f.manifest.organizationId;
  const buyer = await login(f, 'pilot-operator@example.test');
  const approver = await login(f, 'pilot-requester@example.test');
  await addAdmin(f, approver);
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

it('reconciles a lost-response refund from the worker by reading, without another refund, across a restart', async (t) => {
  const f = await settlementFixture(t);
  await f.request('/return-deadlines', {
    commandId: randomUUID(),
    expectedRevision: 0,
    enabled: true,
    receiptHours: 1,
    inspectionHours: 1,
    financialHours: 1,
    sourceMaxAgeSeconds: 300,
  });
  const refund = await f.request(`${f.path}/settlements`, {
    id: randomUUID(),
    kind: 'refund',
  });
  expect(refund.state).toBe('approval_required');
  const refunds = async () =>
    (
      await f.call('runs/operations/records/shopify?kind=Refund&limit=100')
    ).items.filter((r) => r.data.note === `luma-rs:${refund.id}`);
  const settlement = async () =>
    (await f.request(`${f.path}/settlements`)).items.find(
      (item) => item.id === refund.id,
    );
  // The follow-up rereads a case at most once a minute; make it due for the next pass.
  const due = () =>
    f.db.owner.query(
      'DELETE FROM orders_return_deadline_checks WHERE tenant_id=$1 AND case_id=$2',
      [f.org, f.detail.case.id],
    );
  const worker = await purchasingWorker(t, f.purchasingWorkerConfiguration());

  // The API sends the approved refund; Shopify commits it and the response is lost.
  await loseResponse(f, 'shopify', 'returns.refund');
  await f.request(
    `${f.path}/settlements/${refund.id}/decision`,
    { decisionId: refund.decisionId, outcome: 'approved' },
    f.approver,
  );
  expect(await refunds()).toHaveLength(1);
  const actionId = (
    await f.db.owner.query(
      "SELECT document->>'actionId' AS id FROM orders_return_actions WHERE tenant_id=$1 AND id=$2",
      [f.org, refund.id],
    )
  ).rows[0].id;
  expect((await evidence(f, actionId)).executions[0].state).not.toBe(
    'succeeded',
  );

  // While payment is pending, the worker's check reads the refund and reconciles nothing.
  await due();
  await worker.returns();
  expect(await refunds()).toHaveLength(1);
  expect((await settlement()).state).toBe('pending');

  // After payment settles, a restarted worker verifies it by reading and settles the attempt.
  await f.command({ kind: 'refund-settle', order: f.providerOrderId });
  await due();
  await restart(t, f, worker, (next) => next.returns());
  expect(await refunds()).toHaveLength(1);
  expect(await settlement()).toMatchObject({
    state: 'verified',
    proof: { outcome: 'passed', payment: 'paid' },
  });

  const found = await evidence(f, actionId);
  expect(found.executions).toHaveLength(1);
  expect(found.executions[0].state).toBe('succeeded');
  expect(found.executions[0].document.attempt).toMatchObject({
    businessOutcome: 'satisfied',
    verification: { outcome: 'passed' },
  });
  expect(found.approvers).toEqual([f.manifest.requesterId]);
  expect(found).toMatchObject({ prepared: 1, completed: 1 });
  expect(found.reconciled).toBeGreaterThan(0);
  await expectNoWriteReceipt(f, actionId);

  // Every read the quote, the verifications and the settlement audit cite resolves to stored evidence.
  const reads = await citedReturnReads(f, f.detail.case.id);
  expect(reads.cited.length).toBeGreaterThan(1);
  expect(reads.stored.map((row) => row.id).sort()).toEqual(
    [...reads.cited].sort(),
  );
  for (const row of reads.stored)
    expect(row).toMatchObject({
      case_id: f.detail.case.id,
      purpose: 'settlement',
      subject_id: refund.id,
      document: {
        source: {
          provider: 'shopify',
          connectionId: f.connectionId,
          resource: 'refund',
        },
        completeness: 'complete',
      },
    });
});

/** Makes a return write due for the follow-up pass, which rereads a write at most once a minute. */
const dueReturnWrite = (f, table, id) =>
  f.db.owner.query(
    `UPDATE ${table} SET document=jsonb_set(document,'{updatedAt}',to_jsonb(to_char((now()-interval '10 minutes') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) WHERE tenant_id=$1 AND id=$2`,
    [f.org, id],
  );

it('refunds an approved return from the sync worker once and verifies it after a lost response and restart', async (t) => {
  const f = await settlementFixture(t);
  await addAdmin(f, f.approver);
  const refund = await f.request(`${f.path}/settlements`, {
    id: randomUUID(),
    kind: 'refund',
  });
  expect(refund.state).toBe('approval_required');
  const refunds = async () =>
    (
      await f.call('runs/operations/records/shopify?kind=Refund&limit=100')
    ).items.filter((r) => r.data.note === `luma-rs:${refund.id}`);
  const settlement = async () =>
    (await f.request(`${f.path}/settlements`)).items.find(
      (item) => item.id === refund.id,
    );
  let worker = await purchasingWorker(t, f.purchasingWorkerConfiguration());

  // The API records the approval but cannot send as the requester, as after a crash.
  const approved = await withRequesterSuspended(f, f.manifest.operatorId, () =>
    f.request(
      `${f.path}/settlements/${refund.id}/decision`,
      { decisionId: refund.decisionId, outcome: 'approved' },
      f.approver,
    ),
  );
  expect(approved).toMatchObject({ state: 'approved', sent: false });
  expect(await refunds()).toHaveLength(0);

  // The worker sends as the requester; Shopify commits the refund and the response is lost.
  await loseResponse(f, 'shopify', 'returns.refund');
  await worker.returnWrites();
  expect(await refunds()).toHaveLength(1);
  expect((await settlement()).state).not.toBe('verified');

  // After payment settles, a restarted worker only reads and verifies the same refund.
  await f.command({ kind: 'refund-settle', order: f.providerOrderId });
  await dueReturnWrite(f, 'orders_return_actions', refund.id);
  worker = await restart(t, f, worker, (next) => next.returnWrites());
  expect(await refunds()).toHaveLength(1);
  expect(await settlement()).toMatchObject({
    state: 'verified',
    proof: { outcome: 'passed', payment: 'paid' },
  });
  await worker.returnWrites();
  expect(
    (await f.request(`${f.path}/settlements/${refund.id}/send`, {})).state,
  ).toBe('verified');
  expect(await refunds()).toHaveLength(1);

  const actionId = (
    await f.db.owner.query(
      "SELECT document->>'actionId' AS id FROM orders_return_actions WHERE tenant_id=$1 AND id=$2",
      [f.org, refund.id],
    )
  ).rows[0].id;
  const found = await evidence(f, actionId);
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
  await expectNoWriteReceipt(f, actionId);

  // Every read the quote, the verifications and the settlement audit cite resolves to stored evidence.
  const reads = await citedReturnReads(f, f.detail.case.id);
  expect(reads.cited.length).toBeGreaterThan(1);
  expect(reads.stored.map((row) => row.id).sort()).toEqual(
    [...reads.cited].sort(),
  );
  for (const row of reads.stored)
    expect(row).toMatchObject({
      purpose: 'settlement',
      subject_id: refund.id,
      document: {
        caseId: f.detail.case.id,
        source: { provider: 'shopify', connectionId: f.connectionId },
        completeness: 'complete',
      },
    });
});

it('creates an approved return from the sync worker once and records it after a lost response and restart', async (t) => {
  const f = await settlementFixture(t, { prepare: 'opened' });
  await addAdmin(f, f.approver);
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

it('records an approved return refund that was never sent as expired once its approval ends', async (t) => {
  const f = await settlementFixture(t);
  await addAdmin(f, f.approver);
  const refund = await f.request(`${f.path}/settlements`, {
    id: randomUUID(),
    kind: 'refund',
  });
  await withRequesterSuspended(f, f.manifest.operatorId, () =>
    f.request(
      `${f.path}/settlements/${refund.id}/decision`,
      { decisionId: refund.decisionId, outcome: 'approved' },
      f.approver,
    ),
  );
  // The approval window ends before any process sends it.
  await f.db.owner.query(
    `UPDATE orders_return_actions SET document=jsonb_set(document,'{expiresAt}',to_jsonb(to_char((now()-interval '1 minute') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) WHERE tenant_id=$1 AND id=$2`,
    [f.org, refund.id],
  );
  expect(
    (await f.request(`${f.path}/settlements`)).items.find(
      (item) => item.id === refund.id,
    ),
  ).toMatchObject({ state: 'expired', canSend: false });

  const worker = await purchasingWorker(t, f.purchasingWorkerConfiguration());
  await worker.returnWrites();
  expect(
    (
      await f.db.owner.query(
        'SELECT state,sent FROM orders_return_actions WHERE tenant_id=$1 AND id=$2',
        [f.org, refund.id],
      )
    ).rows[0],
  ).toEqual({ state: 'expired', sent: false });
  expect(
    (
      await f.call('runs/operations/records/shopify?kind=Refund&limit=100')
    ).items.filter((r) => r.data.note === `luma-rs:${refund.id}`),
  ).toHaveLength(0);
  // The refund slot is free for a fresh request and approval.
  expect(
    (
      await f.request(`${f.path}/settlements`, {
        id: randomUUID(),
        kind: 'refund',
      })
    ).state,
  ).toBe('approval_required');
});
