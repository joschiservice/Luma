import { randomUUID } from 'node:crypto';

import { createObservability } from '@luma/platform/composition';
import { processWorkflowId } from '@luma/workflow-temporal';
import { expect, it } from 'vitest';

import { replenishmentFixture } from './replenishment-fixture.mjs';

it('retains supplier cost and lead time with the proposal and draft even when terms change during approval', async (t) => {
  const f = await replenishmentFixture(t, undefined, {
    featureFlagOverrides: { 'supplier-purchasing-terms': true },
    observability: createObservability({
      environment: 'test',
      release: 'test',
      sampleRate: 0,
      featureFlagOverrides: { 'supplier-purchasing-terms': true },
    }),
  });
  await f.pilot.commitments.linkSupplier(f.actor, f.supplier.id, {
    expectedRevision: 1,
    link: {
      connectionId: f.manifest.connections.jtl,
      externalId: '1',
      scopeKey: '',
    },
    confirmationHours: 48,
  });
  const skuId = (
    await f.db.owner.query(
      'SELECT s.sku_id FROM inventory_projections p JOIN inventory_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id WHERE p.tenant_id=$1 AND p.entity_id=$2 AND p.connection_id=$3',
      [
        f.manifest.organizationId,
        f.position.positionId,
        f.position.connectionId,
      ],
    )
  ).rows[0].sku_id;
  const terms = async (amount, expectedRevision) => {
    const response = await f.pilot.app.inject({
      method: 'POST',
      url: `/v1/organizations/${f.manifest.organizationId}/procurement/supplier-terms`,
      headers: { cookie: f.ownerCookie, origin: 'http://127.0.0.1:3000' },
      payload: {
        id: randomUUID(),
        supplierId: f.supplier.id,
        skuId,
        expectedRevision,
        reason: 'Reviewed supplier price',
        values: {
          unitPrice: { amount, currency: 'AUD', validFrom: null },
          leadTimeDays: 7,
        },
      },
    });
    expect(response.statusCode, response.body).toBe(200);

    return response.json();
  };
  const saved = await terms('12.50', 0);
  const rule = await f.configure();
  const run = await f.request('/replenishment/starts', {
    id: randomUUID(),
    activationId: rule.id,
  });
  await f.waitFor(run.id, 'awaiting_decision');
  const review = await f.request(`/replenishment/runs/${run.id}`, undefined, {
    cookie: f.approverCookie,
  });
  expect(review.context).toMatchObject({
    unitPrice: { amount: '12.50', currency: 'AUD' },
    totalValue: { amount: '625', currency: 'AUD' },
    leadTimeDays: 7,
  });
  await terms('22.50', saved.revision);
  expect((await f.request(`/replenishment/runs/${run.id}`)).context).toEqual(
    review.context,
  );
  await f.decide(run);
  await f.waitFor(run.id, 'verified');
  const result = await f.request(`/replenishment/runs/${run.id}`);
  const order = await f.pilot.commitments.order(
    f.actor,
    result.purchaseOrder.id,
  );
  expect(order.order.lines[0].unitPrice).toEqual({
    amount: '12.50',
    currency: 'AUD',
  });
  expect(order.value).toEqual({ amount: '625', currency: 'AUD' });
  const request = {
    id: randomUUID(),
    requestedDeliveryDate: new Date(Date.now() + 86400000)
      .toISOString()
      .slice(0, 10),
  };
  const sent = await f.pilot.commitments.requestSubmission(
    f.actor,
    order.order.id,
    request,
  );
  expect(sent.state).toBe('submitted');
  expect(
    (
      await f.pilot.commitments.requestSubmission(
        f.actor,
        order.order.id,
        request,
      )
    ).id,
  ).toBe(sent.id);
  const policy = (
    await f.db.owner.query(
      'SELECT document FROM policy_decisions WHERE tenant_id=$1 AND id=$2',
      [f.manifest.organizationId, sent.decisionId],
    )
  ).rows[0].document;
  expect(policy).toMatchObject({
    outcome: 'allowed',
    reason: 'covered_approval',
  });
  const count = (
    await f.db.owner.query(
      'SELECT count(*)::int AS n FROM policy_approvals WHERE tenant_id=$1 AND proposal_id=ANY($2::uuid[])',
      [f.manifest.organizationId, [order.order.origin.actionId, sent.actionId]],
    )
  ).rows[0].n;
  expect(count).toBe(1);
});

it('replenishes through Temporal, policy, procurement and verification without an exception', async (t) => {
  const f = await replenishmentFixture(t, undefined, { imported: true });
  expect((await f.request('')).presentation).toBe('procurement.replenishment');
  const initialExceptions = (await f.pilot.detection.exceptions.list(f.actor))
    .length;
  const rule = await f.configure();
  const start = { id: randomUUID(), activationId: rule.id };
  const run = await f.request('/replenishment/starts', start);
  expect(run.activationId).toBe(rule.id);
  expect((await f.request('/replenishment/starts', start)).id).toBe(run.id);
  await f.waitFor(run.id, 'awaiting_decision');
  const ownReview = await f.request(`/replenishment/runs/${run.id}`);
  expect(ownReview).toMatchObject({
    quantity: 50,
    canRespond: false,
    supplierId: f.supplier.id,
    stock: {
      available: f.position.available,
      minimum: f.position.available + 10,
      target: f.position.available + 50,
    },
    decision: { outcome: 'approval_required' },
    purchaseOrder: null,
    verification: { state: 'not_verified', recordedAt: null },
  });
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
  expect(await f.request(`/replenishment/runs/${run.id}`)).toMatchObject({
    purchaseOrder: {
      id: order.id,
      reference: order.reference,
      status: 'draft',
    },
    verification: { state: 'verified' },
    decision: { outcome: 'approved' },
    canRespond: false,
  });
  const answered = await f.pilot.app.inject({
    method: 'GET',
    url: `/v1/organizations/${f.manifest.organizationId}/decisions/${encodeURIComponent(`replenishment:${run.id}`)}`,
    headers: { cookie: f.approverCookie },
  });
  expect(answered.statusCode, answered.body).toBe(200);
  expect(answered.json().outcome).toMatchObject({
    state: 'approved',
    next: 'verified',
    purchaseOrderId: order.id,
    workflow: true,
  });
  expect(answered.json().outcome.actorEmail).toBe(
    'pilot-requester@example.test',
  );
  const activity = await f.pilot.app.inject({
    method: 'GET',
    url: `/v1/organizations/${f.manifest.organizationId}/activity?from=${new Date(Date.now() - 86400000).toISOString()}&to=${new Date(Date.now() + 86400000).toISOString()}&q=${run.id}`,
    headers: { cookie: f.ownerCookie },
  });
  expect(activity.statusCode, activity.body).toBe(200);
  expect(
    activity
      .json()
      .items.some((event) => event.action === 'approval.responded'),
  ).toBe(true);
  expect(
    activity
      .json()
      .items.some((event) => event.action === 'purchase_order.created'),
  ).toBe(true);
  expect(
    activity
      .json()
      .items.some((event) => event.action === 'workflow.verification'),
  ).toBe(true);
  expect(
    (await f.pilot.procurement.detail(f.actor, order.id)).history,
  ).toHaveLength(1);
  const timeline = await f.pilot.commitments.order(f.actor, order.id);
  expect(
    timeline.timeline.entries.find((entry) => entry.detail === 'created').actor,
  ).toMatchObject({
    kind: 'member',
    email: 'pilot-operator@example.test',
    workflow: { id: run.id, name: 'Replenish low stock' },
  });
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
  expect(await f.request(`/replenishment/runs/${failed.id}`)).toMatchObject({
    purchaseOrder: { status: 'cancelled' },
    verification: { state: 'failed' },
    canRespond: false,
  });
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

it('keeps a proposal open for hours and rereads stock before creating the order', async (t) => {
  const f = await replenishmentFixture(t, undefined, { imported: true });
  const rule = await f.configure();
  await f.pilot.replenishment.tick(f.actor);
  const [run] = (await f.request('/runs')).items;
  await f.waitFor(run.id, 'awaiting_decision');
  const [item] = (
    await f.pilot.app.inject({
      url: `/v1/organizations/${f.actor.tenantId}/decisions`,
      headers: { cookie: f.approverCookie },
    })
  )
    .json()
    .items.filter((entry) => entry.kind === 'replenishment');
  expect(Date.parse(item.deadline)).toBeGreaterThan(Date.now() + 3 * 3_600_000);
  // A rule with a waiting run starts no second run, however often stock is read.
  await f.pilot.replenishment.tick(f.actor);
  expect((await f.request('/runs')).items).toHaveLength(1);

  // Stock evidence ages past five minutes before the approval; the order uses a fresh read.
  const old = new Date(Date.now() - 6 * 60_000).toISOString();
  await f.db.owner.query(
    `UPDATE inventory_snapshots SET observed_at=$3::timestamptz,document=jsonb_set(document,'{observedAt}',to_jsonb($4::text))
     WHERE tenant_id=$1 AND entity_id=$2`,
    [f.actor.tenantId, f.position.positionId, old, old],
  );
  await f.decide(run);
  await f.waitFor(run.id, 'verified');
  expect((await f.pilot.procurement.orders(f.actor)).items).toEqual([
    expect.objectContaining({
      status: 'draft',
      origin: expect.objectContaining({ workflowRunId: run.id }),
    }),
  ]);
  expect(rule.active).toBe(true);
}, 120000);

it('lets the requester approve replenishment when the team independent approval preference is off', async (t) => {
  const f = await replenishmentFixture(t, undefined, { imported: true });
  const base = `/v1/organizations/${f.manifest.organizationId}`;
  const settings = await f.pilot.app.inject({
    method: 'PATCH',
    url: `${base}/settings/approvals`,
    headers: { cookie: f.approverCookie, origin: 'http://127.0.0.1:3000' },
    payload: {
      commandId: randomUUID(),
      revision: 0,
      alwaysRequireApproval: false,
      requireIndependentApproval: false,
    },
  });
  expect(settings.statusCode, settings.body).toBe(200);
  const rule = await f.configure();
  const run = await f.request('/replenishment/starts', {
    id: randomUUID(),
    activationId: rule.id,
  });
  await f.waitFor(run.id, 'awaiting_decision');
  const review = await f.request(`/replenishment/runs/${run.id}`);
  expect(review.canRespond).toBe(true);
  expect(
    (await f.pilot.replenishment.pending(f.actor)).find(
      (item) => item.runId === run.id,
    )?.canRespond,
  ).toBe(true);
  await f.request(`/replenishment/runs/${run.id}/decision`, {
    decisionId: review.decisionId,
    outcome: 'approved',
  });
  await f.temporal.client.workflow
    .getHandle(processWorkflowId(f.manifest.organizationId, run.id))
    .signal('processDecisionChanged');
  await f.waitFor(run.id, 'verified');
  expect((await f.pilot.procurement.orders(f.actor)).items).toHaveLength(1);
});
