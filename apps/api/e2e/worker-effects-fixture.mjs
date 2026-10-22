import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { expect } from 'vitest';

import { addMembership } from './helpers.mjs';
import { purchasingWorker } from './purchasing-worker-fixture.mjs';
import { expectStoredWriteReceipts } from './write-receipts-fixture.mjs';

const origin = 'http://127.0.0.1:3000';

/**
 * Adds a third admin, so suspending the requester keeps independent approval and the decision's
 * policy version unchanged. Customers add people only by invitation, so the membership is
 * written through the shared fixture.
 */
export async function addAdmin(f) {
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
  await addMembership(
    f.db.owner,
    f.manifest.organizationId,
    response.json().user.id,
    'admin',
  );
}

/**
 * Suspends the requester while an approval is recorded, so the API cannot send as them and the
 * approved write waits for the background pass, as after an API crash between approval and send.
 */
export async function withRequesterSuspended(f, userId, approve) {
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
export const loseResponse = (f, instance, operation) =>
  f.call('runs/operations/control', {
    action: 'fault',
    rule: { instance, operation, kind: 'response-loss', remaining: 1 },
  });

/** The execution record, approvals and audit trail of one action. */
export async function evidence(f, proposalId) {
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
 * Asserts that a write whose response was lost has no receipt: nothing is stored for the
 * attempt, and neither the attempt nor its completion audit cites one.
 */
export async function expectNoWriteReceipt(f, proposalId) {
  const attempts = await expectStoredWriteReceipts(
    f.db.owner,
    f.manifest.organizationId,
    [proposalId],
  );
  expect(attempts).toHaveLength(1);
  expect(attempts[0]).toMatchObject({ cited: [], stored: [] });
}

/** Restarts the worker process and runs one pass in the new one. */
export async function restart(t, f, worker, pass) {
  const pid = worker.pid;
  await worker.stop();
  const next = await purchasingWorker(t, f.purchasingWorkerConfiguration());
  expect(next.pid).not.toBe(pid);
  await pass(next);

  return next;
}

/** Makes a return write due for the follow-up pass, which rereads a write at most once a minute. */
export const dueReturnWrite = (f, table, id) =>
  f.db.owner.query(
    `UPDATE ${table} SET document=jsonb_set(document,'{updatedAt}',to_jsonb(to_char((now()-interval '10 minutes') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) WHERE tenant_id=$1 AND id=$2`,
    [f.org, id],
  );
