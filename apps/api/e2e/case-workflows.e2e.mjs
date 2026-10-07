import { randomUUID } from 'node:crypto';

import { defaultConfiguration } from '@luma/exceptions';
import { expect, test } from 'vitest';

import { caseWorkflowFixture } from './case-workflows-fixture.mjs';
import { until } from './helpers.mjs';

const stock = 'shopify-stock-correction';

/** Links LUMA-001, drifts the shop's stock and lets detection open the case. */
async function driftedStock(f) {
  await f.pilot.observe({ check: false });
  expect(await f.pilot.link()).toEqual({ linked: 1, remaining: 0 });
  await f.pilot.detect();
  const incident = randomUUID();
  await f.call('runs/operations/incidents', {
    id: incident,
    kind: 'inventory-drift',
    target: 'LUMA-001',
  });
  await f.pilot.observe({ check: false });
  await f.pilot.detect();
  const [opened] = (await f.pilot.detection.exceptions.list(f.actor)).filter(
    (item) =>
      item.exceptionClass === 'inventory_mismatch' &&
      item.state !== 'resolved' &&
      !f.pilot.inventoryScenario?.matches(item),
  );
  expect(opened, JSON.stringify(f.pilot.detectionErrors)).toBeDefined();

  return { incident, opened };
}

const shopStock = async (f) =>
  (await f.call('runs/operations/skus/LUMA-001')).shops[0].available;

test('corrects Shopify stock from the ERP after a different admin approves, and detection closes the case', async (t) => {
  const f = await caseWorkflowFixture(t);
  const detail = await f.request(`/workflows/${stock}`);
  expect(detail).toMatchObject({
    presentation: 'workflows.case',
    summary: { status: 'inactive', readiness: { enablement: 'not_enabled' } },
  });
  const { body, activation } = await f.activate(stock);
  // Retrying the same request returns the same activation; a second one conflicts.
  expect(
    await f.request(`/workflows/${stock}/case-activations`, body),
  ).toMatchObject({ id: activation.id, active: true });
  await f.request(
    `/workflows/${stock}/case-activations`,
    { ...body, id: randomUUID() },
    { status: 409 },
  );
  // Case workflows start from detected cases only.
  await f.request(
    `/workflows/${stock}/starts`,
    {
      version: body.version,
      reviewedDigest: body.reviewedDigest,
      subject: { kind: 'inventory_position', id: randomUUID() },
      signal: {
        kind: 'exception',
        sourceId: randomUUID(),
        occurredAt: new Date().toISOString(),
      },
      context: {
        inputs: { activationId: activation.id, caseId: randomUUID() },
        evidence: {
          kind: 'inventory_mismatch',
          facts: { severity: 'medium' },
          observations: [
            {
              id: randomUUID(),
              observedAt: new Date().toISOString(),
              source: 'case:inventory_mismatch',
            },
          ],
        },
        provenance: {
          reference: 'manual',
          capturedAt: new Date().toISOString(),
        },
      },
    },
    { status: 409 },
  );

  const { opened } = await driftedStock(f);
  const before = await shopStock(f);
  const erp = (await f.call('runs/operations/skus/LUMA-001')).erp.available;
  expect(before).not.toBe(erp);
  await f.tick();
  await f.tick();
  const [run, ...others] = await f.runs(stock);
  expect(others).toEqual([]);
  expect(run).toMatchObject({
    triggerEvidence: { sourceId: opened.id },
    subject: { kind: 'inventory_position' },
    activationId: activation.id,
  });
  const waiting = await f.waitFor(stock, run.id, 'awaiting_decision');
  expect(
    waiting.processSteps.find((step) => step.stepId === 'stock').values,
  ).toMatchObject({ ready: true, differs: true, erpAvailable: erp });
  const correction = f.proposal(waiting, 'correct-stock');
  expect(correction).toBeDefined();

  // The activating admin can't approve their own run's change; the owner can.
  const approve = (cookie, status = 200) =>
    f.request(
      '/apps/shopify/inventory-correction-approve',
      { id: correction, outcome: 'approved' },
      { cookie, status },
    );
  await approve(f.operatorCookie, 409);
  await approve(f.approverCookie);
  await f.wake(run.id);
  const verified = await f.waitFor(stock, run.id, 'verified');
  expect(
    verified.processSteps.find((step) => step.stepId === 'check-stock'),
  ).toMatchObject({ state: 'completed', values: { available: erp } });
  expect(await shopStock(f)).toBe(erp);

  // The run never closes the case; independent detection verification does.
  expect(
    (await f.pilot.detection.exceptions.get(f.actor, opened.id)).state,
  ).not.toBe('resolved');
  await f.pilot.observe({ check: false });
  await f.pilot.detect();
  expect(
    await f.pilot.detection.exceptions.get(f.actor, opened.id),
  ).toMatchObject({
    state: 'resolved',
    resolution: { kind: 'verification', outcome: 'passed' },
  });
  // A later pass starts nothing new for the closed case.
  await f.tick();
  expect(await f.runs(stock)).toHaveLength(1);
  expect(
    (await f.request(`/workflows/${stock}`)).summary.readiness,
  ).toMatchObject({
    enablement: 'enabled',
    outcomes: { verified: 1 },
  });
});

test('a rejected correction hands the case to a person without writing to Shopify', async (t) => {
  const f = await caseWorkflowFixture(t);
  await f.activate(stock);
  await driftedStock(f);
  const before = await shopStock(f);
  await f.tick();
  const [run] = await f.runs(stock);

  const waiting = await f.waitFor(stock, run.id, 'awaiting_decision');
  await f.request(
    '/apps/shopify/inventory-correction-approve',
    { id: f.proposal(waiting, 'correct-stock'), outcome: 'rejected' },
    { cookie: f.approverCookie },
  );
  await f.wake(run.id);
  const escalated = await f.waitFor(stock, run.id, 'escalated');
  expect(
    escalated.processSteps.find(
      (step) => step.stepId === 'correct-stock' && step.state === 'escalated',
    ).reason,
  ).toBe('approval_rejected');
  expect(await shopStock(f)).toBe(before);
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

test('releases an overdue fraud hold after approval and leaves warehouse progress to detection', async (t) => {
  const f = await caseWorkflowFixture(t, {
    detection: {
      configuration: {
        ...defaultConfiguration,
        version: 'case-workflows-e2e',
        thresholds: { ...defaultConfiguration.thresholds, stuckSeconds: 1 },
      },
      holdOverdueSeconds: 1,
    },
  });
  const hold = 'shopify-hold-release';
  await f.activate(hold);
  await f.pilot.observe({ check: false });
  await f.call('runs/operations/incidents', {
    id: randomUUID(),
    kind: 'fraud-hold',
  });
  // A fulfillment read before its order waits for the next fulfillment read.
  await f.pilot.observe({ check: false });
  await f.pilot.observe({ check: false });
  await until(
    async () => {
      await f.pilot.detect();

      return (await f.pilot.detection.exceptions.list(f.actor)).some(
        (item) =>
          item.exceptionClass === 'stuck_fulfillment' &&
          item.state !== 'resolved',
      );
    },
    'overdue hold opens a stuck fulfillment',
    15_000,
  );
  // The fixture's other open orders are stuck too, but nothing holds them.
  const stuck = (await f.pilot.detection.exceptions.list(f.actor)).filter(
    (item) => item.exceptionClass === 'stuck_fulfillment',
  );
  let opened;
  for (const item of stuck)
    if (
      (await f.pilot.detection.exceptions.evidence(f.actor, item.id)).some(
        (evidence) => evidence.facts.holds?.length,
      )
    )
      opened = item;
  expect(opened).toBeDefined();
  await f.tick();
  const runs = await f.runs(hold);
  expect(runs).toHaveLength(stuck.length);
  const run = runs.find((item) => item.triggerEvidence.sourceId === opened.id);
  // Without a hold there is nothing to release; an unreadable order goes to a person.
  for (const other of runs.filter((item) => item !== run))
    await f.waitFor(hold, other.id, ['ended', 'escalated']);
  const waiting = await f.waitFor(hold, run.id, 'awaiting_decision');
  expect(
    waiting.processSteps.find((step) => step.stepId === 'hold').values,
  ).toMatchObject({
    ready: true,
    held: true,
    releasable: true,
    reason: 'HIGH_RISK_OF_FRAUD',
  });
  await f.request(
    '/apps/shopify/fulfillment-recovery-approve',
    { id: f.proposal(waiting, 'release-hold'), outcome: 'approved' },
    { cookie: f.approverCookie },
  );
  await f.wake(run.id);
  const verified = await f.waitFor(hold, run.id, 'verified');
  expect(
    verified.processSteps.find((step) => step.stepId === 'check-hold'),
  ).toMatchObject({ state: 'completed', values: { held: false } });
  // Releasing the hold isn't shipping the order; the case stays open until it progresses.
  await f.pilot.observe({ check: false });
  await f.pilot.detect();
  expect(
    (await f.pilot.detection.exceptions.get(f.actor, opened.id)).state,
  ).not.toBe('resolved');
});

test('a connection check ends without handing over when reads have already recovered', async (t) => {
  const f = await caseWorkflowFixture(t);
  const check = 'connection-sync-check';
  await f.activate(check);
  await f.pilot.observe({ check: false });
  await f.call('runs/operations/control', {
    action: 'fault',
    rule: {
      instance: 'shopify',
      operation: 'products.read',
      kind: 'malformed',
      remaining: 100,
    },
  });
  await f.pilot.observe({ check: false });
  await f.pilot.detect();
  const [opened] = (await f.pilot.detection.exceptions.list(f.actor)).filter(
    (item) => item.exceptionClass === 'sync_failure',
  );
  expect(opened).toBeDefined();
  // The provider recovers before the run reads the stream.
  const [fault] = (await f.call('runs/operations')).faults;
  await f.call('runs/operations/control', { action: 'disable', id: fault.id });
  await f.pilot.observe({ check: false });
  await f.tick();
  const [run] = await f.runs(check);
  const ended = await f.waitFor(check, run.id, 'ended');
  expect(
    ended.processSteps.find((step) => step.stepId === 'failure').values,
  ).toMatchObject({ ready: true, failing: false, accessLost: false });
  expect(
    (await f.request(`/workflows/${check}`)).summary.readiness.approval.mode,
  ).toBe('no_actions');
});

test('the simulator demo turns workflows on and shows a scenario’s run on the scorecard', async (t) => {
  const f = await caseWorkflowFixture(t, {
    demo: { workflows: true, detection: 'demo' },
  });
  await f.pilot.observe({ check: false });
  await f.pilot.link();
  // Supplier links read JTL, so the demo completes over passes, as in the running pilot.
  await until(
    async () => {
      const done = await f.pilot.demo();

      return done.workflows === 3 && done.suppliers === 1 && done.rules === 1;
    },
    'demo setup completes',
    15_000,
  );
  expect(await f.pilot.demo()).toEqual({
    workflows: 3,
    suppliers: 1,
    rules: 1,
  });
  for (const id of [stock, 'shopify-hold-release', 'connection-sync-check'])
    expect(
      (await f.request(`/workflows/${id}`)).summary.readiness.enablement,
    ).toBe('enabled');
  const setup = await f.request(
    '/workflows/inventory-replenishment/replenishment',
  );
  expect(setup.rules).toEqual([
    expect.objectContaining({
      sku: 'LUMA-001',
      active: true,
      minimum:
        setup.positions.find(
          (item) =>
            item.sku === 'LUMA-001' &&
            item.connectionId === f.manifest.connections.jtl,
        ).available + 5,
    }),
  ]);

  // The owner turned the workflows on, so the run's change waits for the signed-in admin.
  await f.pilot.detect();
  const [incident] = await f.call('runs/operations/scenarios', {
    id: randomUUID(),
    scenario: 'stock-correction',
  });
  await f.pilot.observe({ check: false });
  await f.pilot.detect();
  await f.pilot.caseWorkflows.tick(await f.pilot.context());
  const [run] = await f.runs(stock);
  await f.waitFor(stock, run.id, 'awaiting_decision');
  await until(
    async () =>
      (await f.call('runs/operations/incidents')).find(
        (item) => item.id === incident.id,
      )?.detection?.workflow?.state === 'awaiting_decision',
    'scorecard shows the waiting run',
    15_000,
  );
});
