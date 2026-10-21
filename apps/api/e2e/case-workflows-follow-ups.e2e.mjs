import { randomUUID } from 'node:crypto';

import { expect, test } from 'vitest';

import { caseWorkflowFixture } from './case-workflows-fixture.mjs';
import { until } from './helpers.mjs';

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
    imported: true,
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
    imported: true,
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
    imported: true,
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
