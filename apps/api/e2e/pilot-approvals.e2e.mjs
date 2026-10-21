import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { until } from './helpers.mjs';
import { pilotFixture } from './pilot-fixture.mjs';

const { setup } = pilotFixture();

test('refreshes expired approval evidence without resetting the case and preserves the independent decision', async (t) => {
  const f = await setup(t, 'approval-required', { proposalFreshnessMs: 2000 });
  const actor = await f.pilot.context();
  const operator = await f.pilot.operator();
  const id = f.manifest.incidents.workflow_failure;
  const input = {
    tenantId: actor.tenantId,
    userId: actor.actor.id,
    requestId: actor.requestId,
    source: { kind: 'incident', id },
  };
  const diagnosis = await f.pilot.detection.diagnoses.get(actor, id);
  const original = await f.pilot.runtime.activities.propose(
    input,
    id,
    diagnosis.revision,
  );
  await f.pilot.runtime.activities.execute(input, id, original);
  await until(
    () => Date.now() > Date.parse(original.expiresAt),
    'proposal expiry',
  );
  await f.pilot.desk.refresh(operator, id);
  const review = await f.pilot.desk.review(operator, id);
  expect(review.proposal.id).not.toBe(original.id);
  expect(review.permittedDecisions).toContain('approve');
  expect((await f.pilot.provider()).patchRequests ?? 0).toBe(0);
  expect(
    await f.pilot.runtime.activities.execute(input, id, original),
  ).toMatchObject({ state: 'proposal_changed' });
  const receipt = await f.pilot.desk.decide(operator, id, {
    commandId: randomUUID(),
    kind: 'approve',
    caseRevision: review.caseRevision,
    diagnosisRevision: review.diagnosisRevision,
    proposalId: review.proposal.id,
    proposalVersion: review.proposal.version,
    decisionId: review.proposal.policy.id,
    reason: 'Checked current order',
  });
  await f.pilot.desk.refresh(operator, id);
  expect((await f.pilot.desk.review(operator, id)).proposal.approval.id).toBe(
    receipt.approvalId,
  );
});

test('refresh refuses changed or completed orders and can recover after a failed read', async (t) => {
  const f = await setup(t, 'approval-required');
  const actor = await f.pilot.context();
  const operator = await f.pilot.operator();
  const id = f.manifest.incidents.workflow_failure;
  const input = {
    tenantId: actor.tenantId,
    userId: actor.actor.id,
    requestId: actor.requestId,
    source: { kind: 'incident', id },
  };
  const diagnosis = await f.pilot.detection.diagnoses.get(actor, id);
  const original = await f.pilot.runtime.activities.propose(
    input,
    id,
    diagnosis.revision,
  );
  await f.pilot.runtime.activities.execute(input, id, original);
  const path = join(f.directory, `provider-${f.manifest.runId}.json`);
  const state = await f.pilot.provider();
  for (const change of [
    { shippingMethodId: '9' },
    { isCancelled: true },
    { shippingDetails: { shippingDate: new Date().toISOString() } },
  ]) {
    await writeFile(
      path,
      JSON.stringify({ ...state, order: { ...state.order, ...change } }),
    );
    await expect(f.pilot.desk.refresh(operator, id)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect((await f.pilot.desk.review(operator, id)).proposal.id).toBe(
      original.id,
    );
    expect((await f.pilot.provider()).patchRequests ?? 0).toBe(0);
  }
  await writeFile(path, '{');
  await expect(f.pilot.desk.refresh(operator, id)).rejects.toMatchObject({
    statusCode: 503,
  });
  await writeFile(path, JSON.stringify(state));
  await expect(f.pilot.desk.refresh(operator, id)).resolves.toBeUndefined();
  expect(
    (await f.pilot.desk.review(operator, id)).permittedDecisions,
  ).toContain('approve');
});

test('execution waits for renewal to publish the replacement diagnosis and proposal', async (t) => {
  const f = await setup(t, 'approval-required', {
    proposalFreshnessMs: 30_000,
  });
  const actor = await f.pilot.context();
  const id = f.manifest.incidents.workflow_failure;
  const input = {
    tenantId: actor.tenantId,
    userId: actor.actor.id,
    requestId: actor.requestId,
    source: { kind: 'incident', id },
  };
  const diagnosis = await f.pilot.detection.diagnoses.get(actor, id);
  const original = await f.pilot.runtime.activities.propose(
    input,
    id,
    diagnosis.revision,
  );
  await f.pilot.runtime.activities.execute(input, id, original);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const diagnose = f.pilot.detection.diagnoses.run;
  f.pilot.detection.diagnoses.run = async (...args) => {
    const result = await diagnose.apply(f.pilot.detection.diagnoses, args);
    entered.resolve();
    await release.promise;

    return result;
  };
  const refresh = f.pilot.desk.refresh(await f.pilot.operator(), id);
  await Promise.race([
    entered.promise,
    refresh.then(() => {
      throw new Error('Renewal completed without running diagnosis');
    }),
  ]);
  let execution;
  try {
    execution = f.pilot.runtime.activities.execute(input, id, original);
    await until(
      async () =>
        (
          await f.db.owner.query(
            "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted",
          )
        ).rowCount > 0,
      'execution waiting for renewal',
    );
  } finally {
    release.resolve();
    f.pilot.detection.diagnoses.run = diagnose;
    await refresh;
  }
  expect(await execution).toMatchObject({ state: 'proposal_changed' });
  expect((await f.pilot.provider()).patchRequests ?? 0).toBe(0);
});

test('renews an approval that expired while the worker was offline and requires a new decision', async (t) => {
  const f = await setup(t, 'approval-required', { proposalFreshnessMs: 4000 });
  const actor = await f.pilot.context();
  const operator = await f.pilot.operator();
  const id = f.manifest.incidents.workflow_failure;
  const input = {
    tenantId: actor.tenantId,
    userId: actor.actor.id,
    requestId: actor.requestId,
    source: { kind: 'incident', id },
  };
  const diagnosis = await f.pilot.detection.diagnoses.get(actor, id);
  const original = await f.pilot.runtime.activities.propose(
    input,
    id,
    diagnosis.revision,
  );
  await f.pilot.runtime.activities.execute(input, id, original);
  const approve = async (review) =>
    f.pilot.desk.decide(operator, id, {
      commandId: randomUUID(),
      kind: 'approve',
      caseRevision: review.caseRevision,
      diagnosisRevision: review.diagnosisRevision,
      proposalId: review.proposal.id,
      proposalVersion: review.proposal.version,
      decisionId: review.proposal.policy.id,
      reason: 'Checked current order',
    });
  const receipt = await approve(await f.pilot.desk.review(operator, id));
  await f.client.start(actor, input.source);
  await until(
    () => Date.now() > Date.parse(original.expiresAt),
    'approval expiry',
  );
  const worker = await f.pilot.runtime.createWorker();
  const running = worker.run();
  t.onTestFinished(async () => {
    worker.shutdown();
    await running;
    await worker.close();
  });
  await until(
    async () =>
      (await f.pilot.desk.review(operator, id)).proposal.id !== original.id,
    'fresh proposal after expired approval',
  );
  const renewed = await f.pilot.desk.review(operator, id);
  expect(renewed.proposal.approval).toBeNull();
  expect((await f.pilot.provider()).patchRequests ?? 0).toBe(0);
  expect(
    (
      await f.db.owner.query('SELECT id FROM policy_approvals WHERE id=$1', [
        receipt.approvalId,
      ])
    ).rowCount,
  ).toBe(1);
  await until(
    async () =>
      (await f.pilot.desk.review(operator, id)).permittedDecisions.includes(
        'approve',
      ),
    'new independent approval',
  );
  await until(async () => {
    try {
      await approve(await f.pilot.desk.review(operator, id));

      return true;
    } catch (error) {
      if (error.statusCode !== 409) throw error;

      return false;
    }
  }, 'approval against the current policy revision');
  await until(
    async () =>
      (await f.pilot.desk.progress(operator, id)).state === 'resolved',
    'approved renewed execution',
  );
  expect((await f.pilot.provider()).patchRequests).toBe(1);
});
