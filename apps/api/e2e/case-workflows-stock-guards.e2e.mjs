import { randomUUID } from 'node:crypto';

import { expect, test } from 'vitest';

import { caseWorkflowFixture } from './case-workflows-fixture.mjs';
import {
  driftedStock,
  shopStock,
  stock,
} from './case-workflows-stock-fixture.mjs';

test('closing an issue blocks its waiting workflow change without counting a verified fix', async (t) => {
  const f = await caseWorkflowFixture(t);
  await f.activate(stock);
  const { opened } = await driftedStock(f);
  await f.tick();
  const [run] = await f.runs(stock);
  const waiting = await f.waitFor(stock, run.id, 'awaiting_decision');
  const before = await shopStock(f);
  const review = await f.request(`/exceptions/${opened.id}/review`);
  await f.request(`/exceptions/${opened.id}/decisions`, {
    commandId: randomUUID(),
    kind: 'close',
    reason: 'The team accepts this discrepancy',
    caseRevision: review.caseRevision,
    diagnosisRevision: review.diagnosisRevision,
  });
  await f.request(
    '/apps/shopify/inventory-correction-approve',
    { id: f.proposal(waiting, 'correct-stock'), outcome: 'approved' },
    { cookie: f.approverCookie },
  );
  await f.wake(run.id);
  const stopped = await f.waitFor(stock, run.id, 'escalated');
  expect(
    stopped.processSteps.find(
      (step) => step.stepId === 'correct-stock' && step.state === 'escalated',
    ).reason,
  ).toBe('case_resolved');
  expect(await shopStock(f)).toBe(before);
  expect(
    (await f.request(`/exceptions/${opened.id}/progress`)).resolution.kind,
  ).toBe('human_disposition');
  await f.tick();
  expect(await f.runs(stock)).toHaveLength(1);
});

test('turning a workflow off stops new runs and blocks a waiting change', async (t) => {
  const f = await caseWorkflowFixture(t);
  const { activation } = await f.activate(stock);
  await driftedStock(f);
  await f.tick();
  const [run] = await f.runs(stock);
  const waiting = await f.waitFor(stock, run.id, 'awaiting_decision');
  const before = await shopStock(f);
  await f.request(`/workflows/${stock}/activations/${activation.id}/revoke`, {
    artifactDigest: activation.artifactDigest,
  });
  // Approval after the workflow was turned off sends nothing.
  await f.request(
    '/apps/shopify/inventory-correction-approve',
    { id: f.proposal(waiting, 'correct-stock'), outcome: 'approved' },
    { cookie: f.approverCookie },
  );
  await f.wake(run.id);
  const stopped = await f.waitFor(stock, run.id, 'escalated');
  expect(
    stopped.processSteps.find(
      (step) => step.stepId === 'correct-stock' && step.state === 'escalated',
    ).reason,
  ).toBe('activation_revoked');
  expect(await shopStock(f)).toBe(before);
  const detail = await f.request(`/workflows/${stock}`);
  expect(detail.summary.readiness.enablement).toBe('paused');
});

test('records observe-only capability work without provider writes or retries after worker replacement', async (t) => {
  const f = await caseWorkflowFixture(t);
  const settings = await f.request('/settings', undefined, {
    cookie: f.approverCookie,
  });
  const mode = async (writeMode, revision) => {
    const response = await f.pilot.app.inject({
      method: 'PATCH',
      url: `${f.base}/settings/write-mode`,
      headers: { cookie: f.approverCookie, origin: 'http://127.0.0.1:3000' },
      payload: { commandId: randomUUID(), revision, writeMode },
    });
    expect(response.statusCode, response.body).toBe(200);

    return response.json();
  };
  const observed = await mode('observe_only', settings.workspace.revision);
  await f.activate(stock);
  const { opened } = await driftedStock(f);
  const before = await shopStock(f);
  const beforeWrites = (
    await f.call(`runs/${f.manifest.simulator.runId}/journal`)
  ).items.filter((entry) => entry.kind === 'provider-write');
  await f.tick();
  const [run] = await f.runs(stock);
  const stopped = await f.waitFor(stock, run.id, 'not_executed');
  expect(stopped.processSteps.at(-1)).toMatchObject({
    stepId: 'correct-stock',
    state: 'not_executed',
    reason: 'observe_only',
  });
  const proposalId = stopped.processSteps.at(-1).values.proposalId;
  expect(
    (
      await f.db.owner.query(
        'SELECT count(*)::int AS n FROM executed_actions WHERE tenant_id=$1 AND proposal_id=$2',
        [f.manifest.organizationId, proposalId],
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await f.db.owner.query(
        'SELECT document FROM execution_observe_only WHERE tenant_id=$1 AND proposal_id=$2',
        [f.manifest.organizationId, proposalId],
      )
    ).rows[0].document,
  ).toMatchObject({ state: 'not_executed', reason: 'observe_only' });
  expect(await shopStock(f)).toBe(before);
  await mode('writes_enabled', observed.workspace.revision);
  await f.restartWorker();
  await expect(f.wake(run.id)).rejects.toThrow(
    'workflow execution already completed',
  );
  await f.tick();
  expect(await f.waitFor(stock, run.id, 'not_executed')).toMatchObject({
    id: run.id,
  });
  expect(await f.runs(stock)).toHaveLength(1);
  expect(await shopStock(f)).toBe(before);
  const journal = await f.call(`runs/${f.manifest.simulator.runId}/journal`);
  expect(
    journal.items.filter((entry) => entry.kind === 'provider-write'),
  ).toEqual(beforeWrites);
  expect(
    (await f.pilot.detection.exceptions.get(f.actor, opened.id)).state,
  ).not.toBe('resolved');
});
