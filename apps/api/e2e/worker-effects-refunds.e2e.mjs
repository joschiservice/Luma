import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { purchasingWorker } from './purchasing-worker-fixture.mjs';
import {
  citedReturnReads,
  providerWrites,
  settlementFixture,
} from './return-settlement-fixture.mjs';
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

it('reconciles a lost-response refund from the worker by reading, without another refund, across a restart', async (t) => {
  const f = await settlementFixture(t, { imported: true });
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

  // The background pass finds the send reserved, so it only reads the refund.
  await dueReturnWrite(f, 'orders_return_actions', refund.id);
  await worker.returnWrites();
  expect(await refunds()).toHaveLength(1);
  expect((await settlement()).state).toBe('pending');

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
  // Shopify received one refund request, the one whose response was lost.
  await expect
    .poll(() => providerWrites(f, 'shopify', 'returns.refund'), {
      timeout: 5_000,
    })
    .toEqual(['response-loss']);

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

it('refunds an approved return from the sync worker once and verifies it after a lost response and restart', async (t) => {
  const f = await settlementFixture(t, { imported: true });
  await addAdmin(f);
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
  // Shopify received one refund request, the one whose response was lost.
  await expect
    .poll(() => providerWrites(f, 'shopify', 'returns.refund'), {
      timeout: 5_000,
    })
    .toEqual(['response-loss']);

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

it('records an approved return refund that was never sent as expired once its approval ends', async (t) => {
  const f = await settlementFixture(t, { imported: true });
  await addAdmin(f);
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
