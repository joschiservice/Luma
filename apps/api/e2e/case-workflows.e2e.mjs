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
  const opened = await stockCase(f);
  expect(opened, JSON.stringify(f.pilot.detectionErrors)).toBeDefined();

  return { incident, opened };
}

/** Runs detection passes until a new stock gap outlasts the journey's sync window. */
async function stockCase(f) {
  return until(async () => {
    await f.pilot.detect();

    return (await f.pilot.detection.exceptions.list(f.actor)).find(
      (item) =>
        item.exceptionClass === 'inventory_mismatch' &&
        item.state !== 'resolved' &&
        !f.pilot.inventoryScenario?.matches(item),
    );
  }, 'detection opens the stock case after the sync window');
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
  // The workflow and its runs name the person who turned it on, not their ID.
  const operator = {
    kind: 'member',
    id: run.actor.id,
    name: 'Synthetic pilot operator',
    email: 'pilot-operator@example.test',
    workflow: null,
  };
  expect((await f.request(`/workflows/${stock}/runs`)).people).toEqual([
    operator,
  ]);
  expect((await f.request(`/workflows/${stock}`)).people).toEqual([operator]);
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

test('lost store access opens a case for a person, and reconnecting closes it after a fresh scan', async (t) => {
  const f = await caseWorkflowFixture(t);
  const check = 'connection-sync-check';
  const shop = f.manifest.connections.shopify;
  await f.activate(check);
  await f.pilot.observe({ check: false });
  const [incident] = await f.call('runs/operations/scenarios', {
    id: randomUUID(),
    scenario: 'access-revoked',
  });
  await f.pilot.observe({ check: false });
  const connection = async (id) =>
    (await f.request('/connections')).items.find((item) => item.id === id);
  expect((await connection(shop)).status).toBe('revoked');

  await f.pilot.detect();
  await f.pilot.detect();
  const lost = (await f.pilot.detection.exceptions.list(f.actor)).filter(
    (item) =>
      item.exceptionClass === 'sync_failure' && item.state !== 'resolved',
  );
  expect(lost, JSON.stringify(f.pilot.detectionErrors)).toEqual([
    expect.objectContaining({
      severity: 'high',
      subject: expect.objectContaining({ subjectId: shop }),
    }),
  ]);
  await f.tick();
  const [run] = await f.runs(check);
  const handed = await f.waitFor(check, run.id, 'escalated');
  expect(
    handed.processSteps.find((step) => step.stepId === 'failure').values,
  ).toMatchObject({ ready: true, accessLost: true });
  await until(
    async () =>
      (await f.call('runs/operations/incidents')).find(
        (item) => item.id === incident.id,
      )?.detection?.state === 'detected',
    'scorecard reports the incident as detected',
    15_000,
  );

  // The provider accepts Luma again, but the case waits for a person to reconnect.
  await f.call(`runs/operations/incidents/${incident.id}/recover`, {});
  await f.pilot.observe({ check: false });
  await f.pilot.detect();
  expect(
    (await f.pilot.detection.exceptions.list(f.actor)).find(
      (item) => item.id === lost[0].id,
    ).state,
  ).not.toBe('resolved');
  const revoked = await connection(shop);
  const pending = await f.request(`/connections/${shop}/credentials`, {
    version: revoked.version,
    credentials: { token: 'reconnected-token' },
  });
  expect(pending).toMatchObject({ id: shop, status: 'pending' });
  expect(
    await f.request(`/connections/${shop}/check`, {
      version: pending.version,
    }),
  ).toMatchObject({ status: 'active' });
  await f.pilot.observe({ check: false });
  await f.pilot.detect();
  expect(
    (await f.pilot.detection.exceptions.list(f.actor)).find(
      (item) => item.id === lost[0].id,
    ).state,
  ).toBe('resolved');

  // A connection a person disconnects raises nothing.
  const jtl = await connection(f.manifest.connections.jtl);
  await f.request(`/connections/${jtl.id}/disconnect`, {
    version: jtl.version,
  });
  await f.pilot.detect();
  expect(
    (await f.pilot.detection.exceptions.list(f.actor)).filter(
      (item) =>
        item.exceptionClass === 'sync_failure' && item.state !== 'resolved',
    ),
  ).toEqual([]);
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

      return done.workflows === 6 && done.suppliers === 1 && done.rules === 1;
    },
    'demo setup completes',
    15_000,
  );
  expect(await f.pilot.demo()).toEqual({
    workflows: 6,
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
  await stockCase(f);
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

test('a proposal waits hours for a decision, one item follows a stock change, and a late approval acts on a fresh read', async (t) => {
  const f = await caseWorkflowFixture(t);
  await f.activate(stock);
  await driftedStock(f);
  await f.tick();
  const [run] = await f.runs(stock);
  const waiting = await f.waitFor(stock, run.id, 'awaiting_decision');
  const first = f.proposal(waiting, 'correct-stock');
  const items = async () =>
    (
      await f.request('/decisions', undefined, { cookie: f.approverCookie })
    ).items.filter((item) => item.kind === 'inventory_correction');
  const [item] = await items();
  // People get a decision window instead of five minutes.
  expect(Date.parse(item.deadline)).toBeGreaterThan(Date.now() + 3 * 3_600_000);

  // Shopify moves while nobody decides: the workflow prepares one replacement, in the same item.
  await f.call('runs/operations/control', {
    action: 'command',
    instance: 'shopify',
    command: { kind: 'available', variant: '1', location: '1', quantity: 41 },
  });
  await f.wake(run.id);
  await until(
    async () => {
      const current = await items();

      return (
        current.length === 1 &&
        current[0].id === item.id &&
        current[0].change.some((fact) => fact.value === '41 units')
      );
    },
    'one item shows the replacement proposal',
    30_000,
  );
  await f.request(
    '/apps/shopify/inventory-correction-approve',
    { id: first, outcome: 'approved' },
    { cookie: f.approverCookie, status: 409 },
  );

  const inspected = await f.request(
    '/apps/shopify/inventory-correction-inspect',
    {
      positionId: run.subject.id,
      connectionId: f.manifest.connections.shopify,
      sourceConnectionId: f.manifest.connections.jtl,
    },
    { cookie: f.approverCookie },
  );
  const current = inspected.runs.find(
    (entry) => entry.state === 'approval_required',
  );
  expect(current.id).not.toBe(first);
  await f.request(
    '/apps/shopify/inventory-correction-approve',
    { id: current.id, outcome: 'approved' },
    { cookie: f.approverCookie },
  );
  // The ERP report ages past five minutes after approval; the write rereads it first.
  const old = new Date(Date.now() - 6 * 60_000).toISOString();
  await f.db.owner.query(
    `UPDATE inventory_snapshots SET observed_at=$3::timestamptz,document=jsonb_set(document,'{observedAt}',to_jsonb($4::text))
     WHERE tenant_id=$1 AND connection_id=$2`,
    [f.manifest.organizationId, f.manifest.connections.jtl, old, old],
  );

  await f.wake(run.id);
  const verified = await f.waitFor(stock, run.id, 'verified');
  expect(
    verified.processSteps.find((step) => step.stepId === 'check-stock').values
      .available,
  ).toBe((await f.call('runs/operations/skus/LUMA-001')).erp.available);
  expect(await shopStock(f)).toBe(
    (await f.call('runs/operations/skus/LUMA-001')).erp.available,
  );
});

/** The Needs you items a workflow handed to a person. */
const handovers = async (f, definitionId) =>
  (
    await f.request('/decisions?view=all&limit=100', undefined, {
      cookie: f.approverCookie,
    })
  ).items.filter(
    (item) =>
      item.kind === 'workflow_handover' &&
      item.owner.definitionId === definitionId,
  );

/** Starts a scenario preset and returns its incident. */
const scenario = async (f, name) =>
  (
    await f.call('runs/operations/scenarios', {
      id: randomUUID(),
      scenario: name,
    })
  )[0];

test('a payment that stays pending goes to a person and leaves Needs you once it settles', async (t) => {
  const f = await caseWorkflowFixture(t, {
    detection: { followUps: { paymentWaitMs: 0 } },
  });
  const id = 'payment-follow-up';
  await f.pilot.observe({ check: false });
  await f.activate(id);
  const incident = await scenario(f, 'payment-stuck');
  const label = incident.resources[0].label;
  await f.pilot.observe({ check: false });
  await f.tick();
  let item;
  await until(
    async () => {
      item = (await handovers(f, id)).find((entry) =>
        entry.title.endsWith(label),
      );

      return !!item;
    },
    'the stuck payment is handed to a person',
    30_000,
  );
  expect(item).toMatchObject({
    reason: 'manual_intervention',
    response: 'investigate',
    domain: 'orders',
    record: { kind: 'order' },
  });
  const [run] = (await f.runs(id)).filter(
    (entry) => entry.id === item.owner.runId,
  );
  expect(run.processState).toBe('escalated');

  // The payment settles; the item leaves without anyone closing it.
  await f.call(`runs/operations/incidents/${incident.id}/recover`, {});
  await f.pilot.observe({ check: false });
  expect((await handovers(f, id)).some((entry) => entry.id === item.id)).toBe(
    false,
  );
});

test('a return that arrived without a refund goes to a person, and Luma never refunds', async (t) => {
  const f = await caseWorkflowFixture(t, {
    detection: { followUps: { refundWaitMs: 0 } },
  });
  const id = 'refund-follow-up';
  await f.pilot.observe({ check: false });
  await f.activate(id);
  const incident = await scenario(f, 'refund-missing');
  const label = incident.resources[0].label;
  await f.pilot.observe({ check: false });
  await f.tick();
  let item;
  await until(
    async () => {
      item = (await handovers(f, id)).find((entry) =>
        entry.title.endsWith(label),
      );

      return !!item;
    },
    'the waiting refund is handed to a person',
    30_000,
  );
  expect(item.subject.detail).toContain('no refund is recorded');
  expect(
    (await f.request(`/workflows/${id}`)).summary.readiness.approval.mode,
  ).toBe('no_actions');

  await f.call(`runs/operations/incidents/${incident.id}/recover`, {});
  await f.pilot.observe({ check: false });
  expect((await handovers(f, id)).some((entry) => entry.id === item.id)).toBe(
    false,
  );
});

test('a silent supplier: Luma notes the follow-up, waits, and hands the order back to a buyer', async (t) => {
  const f = await caseWorkflowFixture(t, {
    detection: { followUps: { supplierWaitSeconds: 3 } },
  });
  const id = 'supplier-follow-up';
  const org = f.manifest.organizationId;
  await f.pilot.observe({ check: false });
  await scenario(f, 'supplier-silent');
  const supplier = await f.request('/procurement/suppliers', {
    id: randomUUID(),
    name: 'Nordwind Textil',
    externalReferences: [],
  });
  const jtl = f.manifest.connections.jtl;
  const found = (
    await f.request(`/procurement/purchasing-connections/${jtl}/suppliers`)
  ).items.find((item) => item.externalId === '1');
  await f.request(`/procurement/suppliers/${supplier.id}/link`, {
    expectedRevision: 1,
    link: { connectionId: jtl, externalId: '1', scopeKey: found.scopeKey },
    confirmationHours: 1,
  });
  await f.activate(id);
  const sku = (
    await f.db.owner.query(
      `SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2
       AND resource='sku' AND external_id='2'`,
      [org, jtl],
    )
  ).rows[0].canonical_id;
  const order = await f.request('/procurement/purchase-orders', {
    id: randomUUID(),
    supplierId: supplier.id,
    reference: 'PO-FOLLOW-1',
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
  const requested = await f.request(
    `/procurement/purchase-orders/${order.id}/submissions`,
    {
      id: randomUUID(),
      requestedDeliveryDate: new Date(Date.now() + 7 * 86_400_000)
        .toISOString()
        .slice(0, 10),
    },
  );
  expect(
    await f.request(
      `/procurement/submissions/${requested.id}/decision`,
      { decisionId: requested.decisionId, outcome: 'approved' },
      { cookie: f.approverCookie },
    ),
  ).toMatchObject({ state: 'submitted' });
  // The order went out two hours ago, so the one-hour confirmation time has passed.
  await f.db.owner.query(
    `UPDATE procurement_submissions SET document=jsonb_set(document,'{submittedAt}',to_jsonb($3::text))
     WHERE tenant_id=$1 AND id=$2`,
    [org, requested.id, new Date(Date.now() - 2 * 3_600_000).toISOString()],
  );
  const overdue = async () =>
    (
      await f.request('/decisions?view=all&limit=100', undefined, {
        cookie: f.approverCookie,
      })
    ).items.filter(
      (item) =>
        item.kind === 'supplier_commitment' &&
        item.owner.purchaseOrderId === order.id &&
        item.group.key === 'supplier:confirmation_overdue',
    );
  expect(await overdue()).toHaveLength(1);

  await f.tick();
  const [run] = await f.runs(id);
  await f.waitFor(id, run.id, 'waiting');
  // The follow-up is on the order, so buyers aren't asked while Luma waits.
  const record = await f.request(
    `/procurement/purchase-orders/${order.id}/record`,
  );
  expect(record.followUps).toEqual([
    expect.objectContaining({ response: 'following_up' }),
  ]);
  expect(await overdue()).toHaveLength(0);

  const handed = await f.waitFor(id, run.id, 'escalated');
  expect(
    handed.processSteps.find((step) => step.stepId === 'recheck').values,
  ).toMatchObject({ ready: true, waiting: true });
  // The order's own item asks the buyer again; no second item is added.
  await until(
    async () => (await overdue()).length === 1,
    'the order returns to Needs you',
    15_000,
  );
  expect(await handovers(f, id)).toEqual([]);
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
