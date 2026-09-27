import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { replenishmentFixture } from './replenishment-fixture.mjs';

it('replenishes through Temporal, policy, procurement and verification without an exception', async (t) => {
  const f = await replenishmentFixture(t);
  const initialExceptions = (await f.pilot.detection.exceptions.list(f.actor))
    .length;
  const rule = await f.configure();
  const start = { id: randomUUID(), activationId: rule.id };
  const run = await f.request('/replenishment/starts', start);
  expect(run.activationId).toBe(rule.id);
  expect((await f.request('/replenishment/starts', start)).id).toBe(run.id);
  await f.waitFor(run.id, 'awaiting_decision');
  const ownReview = await f.request(`/replenishment/runs/${run.id}`);
  expect(ownReview).toMatchObject({ quantity: 50, canRespond: false });
  await f.request(
    `/replenishment/runs/${run.id}/decision`,
    { decisionId: ownReview.decisionId, outcome: 'approved' },
    { status: 409 },
  );
  // Persisted approval waits survive worker restart. Retrying a start preserves its Temporal ID.
  await f.stopWorker();
  await f.startWorker();
  await f.decide(run);
  const result = await f.waitFor(run.id, 'verified');
  expect(result.processSteps.at(-1).values.outcome).toContain(
    'independently verified',
  );
  const orders = await f.pilot.procurement.orders(f.actor);
  expect(orders.items).toHaveLength(1);
  const order = orders.items[0];
  expect(order).toMatchObject({
    authority: 'luma',
    status: 'draft',
    origin: { workflowRunId: run.id },
    lines: [{ quantity: 50 }],
  });
  expect(
    (await f.pilot.procurement.detail(f.actor, order.id)).history,
  ).toHaveLength(1);
  expect((await f.request('/replenishment/starts', start)).id).toBe(run.id);
  expect((await f.pilot.procurement.orders(f.actor)).items).toHaveLength(1);
  expect((await f.pilot.detection.exceptions.list(f.actor)).length).toBe(
    initialExceptions,
  );

  // Draft and open commitments both stop a new proposal before admission.
  const duplicate = await f.request('/replenishment/starts', {
    id: randomUUID(),
    activationId: rule.id,
  });
  expect(
    (await f.waitFor(duplicate.id, 'ended')).processSteps.find(
      (step) => step.stepId === 'proposal',
    ).values.committed,
  ).toBe(true);
  expect((await f.pilot.procurement.orders(f.actor)).items).toHaveLength(1);
  const opened = await f.pilot.procurement.transition(f.actor, order.id, {
    id: randomUUID(),
    expectedRevision: 1,
    status: 'open',
    reason: 'Scenario: existing open purchase order',
  });
  const covered = await f.request('/replenishment/starts', {
    id: randomUUID(),
    activationId: rule.id,
  });
  await f.waitFor(covered.id, 'ended');
  await f.pilot.procurement.transition(f.actor, order.id, {
    id: randomUUID(),
    expectedRevision: opened.revision,
    status: 'cancelled',
    reason: 'Reset scenario commitment',
  });

  const denied = await f.request('/replenishment/starts', {
    id: randomUUID(),
    activationId: rule.id,
  });
  await f.decide(denied, 'rejected');
  const rejected = await f.waitFor(denied.id, 'escalated');
  expect(rejected.processSteps.at(-1).reason).toBe('approval_rejected');
  expect((await f.pilot.procurement.orders(f.actor)).items).toHaveLength(1);

  // Expiring the authoritative projection after the trigger must stop the durable run.
  const old = await f.db.owner.query(
    'SELECT id,document FROM inventory_snapshots WHERE tenant_id=$1 AND entity_id=$2',
    [f.actor.tenantId, f.position.positionId],
  );
  f.setBeforeRead(async (_run, step) => {
    if (step.id !== 'inventory') return;
    await f.db.owner.query(
      "UPDATE inventory_snapshots SET document=jsonb_set(document,'{observedAt}',to_jsonb($3::text)) WHERE tenant_id=$1 AND entity_id=$2",
      [
        f.actor.tenantId,
        f.position.positionId,
        new Date(Date.now() - 600000).toISOString(),
      ],
    );
  });
  const stale = await f.request('/replenishment/starts', {
    id: randomUUID(),
    activationId: rule.id,
  });
  expect(
    (await f.waitFor(stale.id, 'escalated')).processSteps.at(-1).stepId,
  ).toBe('fresh-stock');
  await f.request(
    '/replenishment/starts',
    { id: randomUUID(), activationId: rule.id },
    { status: 409 },
  );
  for (const row of old.rows)
    await f.db.owner.query(
      'UPDATE inventory_snapshots SET document=$2 WHERE id=$1',
      [row.id, row.document],
    );
  f.setBeforeRead(async () => {});

  // Verification reads actual state after a concurrent operator cancellation.
  f.setBeforeVerify(async (current) => {
    const order = (await f.pilot.procurement.orders(f.actor)).items.find(
      (o) => o.origin.workflowRunId === current.id,
    );
    await f.pilot.procurement.transition(f.actor, order.id, {
      id: randomUUID(),
      expectedRevision: order.revision,
      status: 'cancelled',
      reason: 'Scenario: change postcondition before verification',
    });
  });
  const failed = await f.request('/replenishment/starts', {
    id: randomUUID(),
    activationId: rule.id,
  });
  await f.decide(failed);
  expect((await f.waitFor(failed.id, 'failed_verification')).verification).toBe(
    'failed',
  );
  await f.request(`/activations/${rule.id}/revoke`, {
    artifactDigest: rule.artifactDigest,
  });
  await f.request(
    `/activations/${rule.id}/revoke`,
    { artifactDigest: rule.artifactDigest },
    { cookie: f.approverCookie },
  );
  await f.request(
    '/replenishment/starts',
    { id: randomUUID(), activationId: rule.id },
    { status: 409 },
  );
}, 120000);

it('deduplicates monitored conditions and isolates rules, reviews and decisions by current membership', async (t) => {
  const f = await replenishmentFixture(t);
  const rule = await f.configure();
  await Promise.all([
    f.pilot.replenishment.tick(f.actor),
    f.pilot.replenishment.tick(f.actor),
  ]);
  const runs = (await f.request('/runs')).items;
  expect(runs).toHaveLength(1);
  const run = runs[0];
  await f.waitFor(run.id, 'awaiting_decision');
  await f.pilot.replenishment.tick(f.actor);
  expect((await f.request('/runs')).items).toHaveLength(1);
  const other = await f.pilot.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: { cookie: f.approverCookie, origin: 'http://127.0.0.1:3000' },
    payload: {
      name: 'Other workspace',
      slug: `other-${randomUUID()}`,
      dataRegion: 'EU',
    },
  });
  expect(other.statusCode, other.body).toBe(201);
  const isolated = await f.pilot.app.inject({
    url: `/v1/organizations/${other.json().id}/workflows/inventory-replenishment/replenishment/runs/${run.id}`,
    headers: { cookie: f.approverCookie },
  });
  expect(isolated.statusCode, isolated.body).toBe(404);
  await f.db.owner.query(
    "UPDATE memberships SET role='member' WHERE tenant_id=$1 AND user_id=$2",
    [f.actor.tenantId, f.actor.actor.id],
  );
  expect((await f.request('/replenishment')).canManage).toBe(false);
  expect((await f.request(`/replenishment/runs/${run.id}`)).canRespond).toBe(
    false,
  );
  await f.request(
    '/replenishment/starts',
    { id: randomUUID(), activationId: rule.id },
    { status: 403 },
  );
  await f.db.owner.query(
    "UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2",
    [f.actor.tenantId, f.actor.actor.id],
  );
  await f.decide(run);
  await f.waitFor(run.id, 'verified');
  const response = await f.pilot.app.inject({
    url: `/v1/organizations/${f.actor.tenantId}/activity?from=${new Date(Date.now() - 3600000).toISOString()}&to=${new Date(Date.now() + 3600000).toISOString()}&limit=100`,
    headers: { cookie: f.ownerCookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(
    response
      .json()
      .items.some((item) => item.playbookId === 'inventory-replenishment'),
  ).toBe(true);
}, 120000);
