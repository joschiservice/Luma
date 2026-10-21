import { randomUUID } from 'node:crypto';

import { expect, test } from 'vitest';

import { until } from './helpers.mjs';
import {
  quantityChangeFixture,
  workflow,
} from './order-quantity-change-fixture.mjs';

test('carries a quantity change from Luma ERP to Shopify after the warehouse confirms, and detection closes the case only after fresh reads', async (t) => {
  const f = await quantityChangeFixture(t);
  const detail = await f.request(`/workflows/${workflow}`);
  expect(detail.summary.readiness).toMatchObject({
    enablement: 'not_enabled',
    approval: { mode: expect.any(String) },
  });
  await f.activate(workflow);

  // The customer asked support for one unit instead of two.
  await f.changeQuantity('1');
  const opened = await f.caseOpened();
  expect(opened.subject).toMatchObject({
    subjectKind: 'order',
    subjectId: f.shop,
    scope: [
      f.lineKey,
      ...[
        f.connections.erp,
        f.connections.jtl,
        f.connections.shopify,
        f.manifest.connections.starshipit,
      ].sort(),
    ],
  });
  const caseDetail = await f.request(`/exceptions/${opened.id}`);
  expect(caseDetail.summary).toContain(
    'Luma ERP sets this quantity to 1; Shopify still shows 2',
  );
  expect(caseDetail.summary).toContain('JTL doesn’t report it');
  expect(caseDetail.summary).toMatch(/Starshipit.*report/i);
  const evidence = await f.pilot.detection.exceptions.evidence(
    f.actor,
    opened.id,
  );
  expect(
    evidence
      .filter((item) => item.connectionId)
      .map((item) => [item.connectionId, item.facts.quantity])
      .sort(),
  ).toEqual(
    [
      [f.connections.erp, '1'],
      [f.connections.jtl, null],
      [f.manifest.connections.starshipit, null],
      [f.connections.shopify, '2'],
    ].sort(),
  );

  const run = await f.run();
  const waiting = await f.waitFor(workflow, run.id, 'waiting');
  expect(
    waiting.processSteps.find((step) => step.stepId === 'plan'),
  ).toMatchObject({
    state: 'completed',
    values: { ready: true, targetQuantity: 1, workStarted: false },
  });
  // A person in the warehouse owns the next step; the case now has a responsible owner.
  const task = await f.task(run.id);
  expect(task).toMatchObject({
    assignee: { kind: 'role', key: 'member' },
    escalationTarget: { kind: 'role', key: 'admin' },
    choices: ['Adjusted', 'Cannot adjust'],
  });
  expect((await f.request(`/exceptions/${opened.id}`)).owner).toMatchObject({
    userId: f.manifest.operatorId,
  });
  const queue = await f.request('/decisions', undefined, {
    cookie: f.warehouseCookie,
  });
  expect(queue.items).toContainEqual(
    expect.objectContaining({
      kind: 'human_task',
      record: { kind: 'order', id: f.shop },
    }),
  );

  await f.answer(run.id, 'Adjusted');
  // The edit waits for someone else who can approve changes.
  await f.waitFor(workflow, run.id, 'awaiting_decision');
  const approvals = await f.request('/decisions', undefined, {
    cookie: f.approverCookie,
  });
  expect(approvals.items).toContainEqual(
    expect.objectContaining({
      kind: 'order_edit',
      reason: 'approval',
      response: 'decide',
    }),
  );
  const proposalId = await f.approve(run.id);
  const verified = await f.waitFor(workflow, run.id, 'verified');
  expect(
    verified.processSteps.find((step) => step.stepId === 'check-everywhere'),
  ).toMatchObject({
    state: 'completed',
    values: { quantity: 1, agreed: true, reporting: 2, notReporting: 2 },
  });
  expect(proposalId).toBeTruthy();
  expect(await f.commits()).toHaveLength(1);

  // The run never closes the case; the next detection pass verifies it with fresh reads.
  expect(
    (await f.pilot.detection.exceptions.get(f.actor, opened.id)).state,
  ).not.toBe('resolved');
  const resolved = await until(async () => {
    await f.pilot.detect();
    const current = await f.pilot.detection.exceptions.get(f.actor, opened.id);

    return current.state === 'resolved' ? current : null;
  }, 'detection verifies the case');
  expect(resolved.resolution).toMatchObject({
    kind: 'verification',
    outcome: 'passed',
    complete: true,
    authoritative: true,
  });
  const plan = await f.request(
    `/orders/${f.shop}/change-plan?kind=quantity&lineKey=${f.lineKey}&quantity=1`,
  );
  expect(
    plan.plans[0].acknowledgements
      .map((item) => [item.connectionId, item.state])
      .sort(),
  ).toEqual(
    [
      [f.connections.erp, 'reflects'],
      [f.connections.jtl, 'unknown'],
      [f.manifest.connections.starshipit, 'unknown'],
      [f.connections.shopify, 'reflects'],
    ].sort(),
  );
}, 300_000);

test('a simulated customer’s quantity request reaches Luma through support, and the scorecard reports the case', async (t) => {
  const f = await quantityChangeFixture(t);
  const id = randomUUID();
  await f.call('runs/operations/incidents', {
    id,
    kind: 'order-quantity-change',
  });
  // Retrying the injection changes nothing.
  await f.call('runs/operations/incidents', {
    id,
    kind: 'order-quantity-change',
  });
  expect(await f.pilot.quantityChanges()).toEqual({ changed: 1, waiting: 0 });
  expect(await f.pilot.quantityChanges()).toEqual({ changed: 0, waiting: 0 });
  const injected = (await f.call('runs/operations/incidents')).find(
    (item) => item.id === id,
  );
  const order = injected.resources.find((item) => item.kind === 'Order');
  const orderId = (
    await f.db.owner.query(
      "SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource='order' AND external_id=$3",
      [f.manifest.organizationId, f.connections.shopify, order.id],
    )
  ).rows[0].canonical_id;
  const record = await f.api('GET', `/sales/orders/${orderId}`);
  expect(
    record.lines.map((line) => [
      Number(line.quantity),
      Number(line.currentQuantity),
    ]),
  ).toContainEqual([2, 1]);
  const opened = await f.caseOpened();
  expect(opened.subject.subjectId).toBe(orderId);
  const [incident] = (await f.call('runs/operations/incidents')).filter(
    (item) => item.id === id,
  );
  expect(incident).toMatchObject({
    expected: { exceptionClass: 'order_quantity_mismatch', surface: 'case' },
    detection: { state: 'detected', caseId: opened.id },
  });
}, 300_000);
