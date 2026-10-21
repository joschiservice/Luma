import { randomUUID } from 'node:crypto';

import { expect, test } from 'vitest';

import { caseWorkflowFixture } from './case-workflows-fixture.mjs';
import {
  driftedStock,
  shopStock,
  stock,
} from './case-workflows-stock-fixture.mjs';
import { until } from './helpers.mjs';

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
  const progress = await f.request(`/exceptions/${opened.id}/progress`);
  expect(progress).toMatchObject({
    state: 'resolved',
    resolution: { kind: 'verification' },
    workflowRuns: [
      {
        id: run.id,
        definitionId: stock,
        actions: [
          {
            proposalId: correction,
            diff: {
              capability: 'inventory.available.reconcile',
              records: [
                {
                  changes: expect.arrayContaining([
                    expect.objectContaining({ field: 'available', after: erp }),
                  ]),
                },
              ],
            },
            approval: { outcome: 'approved' },
            execution: {
              state: 'succeeded',
              verification: { outcome: 'passed' },
            },
          },
        ],
      },
    ],
  });
  expect(
    progress.people.some(
      (person) =>
        person.id === progress.workflowRuns[0].actions[0].approval.actorId,
    ),
  ).toBe(true);
  expect(
    progress.workflowRuns[0].steps.find(
      (step) => step.stepId === 'check-stock',
    ),
  ).toMatchObject({ kind: 'verification', state: 'completed' });
  const history = await f.request(
    `/exceptions/${opened.id}/timeline?limit=100`,
  );
  expect(
    history.items.filter((event) => event.type === 'exception.detected'),
  ).toHaveLength(1);
  expect(
    history.items.some(
      (event) =>
        event.type === 'execution.completed' && event.proposalId === correction,
    ),
  ).toBe(true);
  await f.request(`/exceptions/${randomUUID()}/progress`, undefined, {
    status: 404,
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
