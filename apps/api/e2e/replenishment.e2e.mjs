import { randomUUID } from 'node:crypto';

import { createObservability } from '@luma/platform/composition';
import { processWorkflowId } from '@luma/workflow-temporal';
import { Client } from 'pg';
import { expect, it, vi } from 'vitest';

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
});

it('replenishes through Temporal, policy, procurement and verification without an exception', async (t) => {
  const f = await replenishmentFixture(t);
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
      dataRegion: globalThis.process.env.LUMA_REGION ?? 'AU',
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

it('reports readiness, previews bulk setup and keeps every surface honest when stock goes stale', async (t) => {
  const f = await replenishmentFixture(t);
  const org = f.manifest.organizationId;
  const coverage = async (positionId, { cookie = f.ownerCookie } = {}) => {
    const response = await f.pilot.app.inject({
      url: `/v1/organizations/${org}/workflow-coverage?subjectKind=inventory_position&subjectId=${positionId}`,
      headers: { cookie },
    });

    return response;
  };
  const summary = async () => (await f.request('')).summary.readiness;

  // Nothing is set up: ready to set up, approval applies to every draft regardless of quantity.
  const initial = await summary();
  expect(initial).toMatchObject({
    enablement: 'not_enabled',
    state: 'ready',
    coverage: { covered: 0 },
    approval: { mode: 'every_action' },
    waiting: { count: 0 },
    nextAction: { repair: { destination: 'workflow_rules' } },
  });
  const listed = (
    await f.pilot.app.inject({
      url: `/v1/organizations/${org}/workflows`,
      headers: { cookie: f.ownerCookie },
    })
  )
    .json()
    .items.find((item) => item.id === 'inventory-replenishment');
  expect(listed.readiness).toEqual(initial);

  // A position can have several sources; a rule covers the position once.
  const setup = await f.request('/replenishment');
  const positions = [
    f.position,
    ...setup.positions.filter((p) => p.positionId !== f.position.positionId),
  ]
    .filter(
      (p, index, all) =>
        all.findIndex((other) => other.positionId === p.positionId) === index,
    )
    .slice(0, 3);
  const detail = await f.request('');
  const item = (position, overrides = {}) => ({
    positionId: position.positionId,
    connectionId: position.connectionId,
    minimum: Math.max(1, (position.available ?? 0) + 10),
    target: Math.max(50, (position.available ?? 0) + 50),
    approvalQuantity: 20,
    ...overrides,
  });

  // A preview lists each target, flags invalid quantities and changes nothing.
  const preview = await f.request('/replenishment/previews', {
    supplierId: f.supplier.id,
    items: [
      item(positions[0]),
      ...positions
        .slice(1)
        .map((position) => item(position, { minimum: 5, target: 5 })),
    ],
  });
  expect(preview.supplier.name).toBe('Northstar Supply');
  expect(preview.approval.mode).toBe('every_action');
  expect(preview.items).toHaveLength(positions.length);
  expect(preview.items[0]).toMatchObject({
    outcome: 'ready',
    belowMinimum: true,
    proposedQuantity: expect.any(Number),
  });
  for (const invalid of preview.items.slice(1))
    expect(invalid.outcome).toBe('invalid');
  expect((await f.request('/replenishment')).rules).toHaveLength(0);
  await f.request(
    '/replenishment/previews',
    {
      supplierId: f.supplier.id,
      items: [item(positions[0]), item(positions[0])],
    },
    { status: 400 },
  );

  // Bulk activation reports each result; a replay never duplicates or widens a grant.
  const rules = positions.map((position) => ({
    ...item(position),
    id: randomUUID(),
    supplierId: f.supplier.id,
    reviewedDigest: detail.versions[0].digest,
  }));
  const first = await f.request('/replenishment/activations/batch', {
    items: rules,
  });
  expect(first.results.map((result) => result.status)).toEqual(
    rules.map(() => 'activated'),
  );
  for (const [index, result] of first.results.entries())
    expect(result.activation.grants).toEqual({
      principalIds: [f.actor.actor.id],
      connectionIds: [rules[index].connectionId],
      targetIds: [rules[index].positionId],
    });
  const replay = await f.request('/replenishment/activations/batch', {
    items: rules,
  });
  expect(replay.results.map((result) => result.status)).toEqual(
    rules.map(() => 'activated'),
  );
  const replacement = await f.request('/replenishment/activations/batch', {
    items: [{ ...rules[0], id: randomUUID(), minimum: 1 }],
  });
  expect(replacement.results[0]).toMatchObject({
    status: 'failed',
    code: 'covered',
    activation: null,
  });
  expect(
    (await f.request('/replenishment')).rules.filter((rule) => rule.active),
  ).toHaveLength(rules.length);
  const covered = await f.request('/replenishment/previews', {
    supplierId: f.supplier.id,
    items: [item(positions[0])],
  });
  expect(covered.items[0]).toMatchObject({
    outcome: 'covered',
    existingRule: { id: rules[0].id },
  });

  const enabled = await summary();
  expect(enabled).toMatchObject({
    enablement: 'enabled',
    state: 'ready',
    coverage: { covered: rules.length, ready: rules.length },
  });
  const record = await coverage(positions[0].positionId);
  expect(record.statusCode, record.body).toBe(200);
  expect(record.json().items[0]).toMatchObject({
    definitionId: 'inventory-replenishment',
    rule: { id: rules[0].id, active: true },
    readiness: {
      enablement: 'enabled',
      state: 'ready',
      coverage: { covered: 1, ready: 1 },
    },
  });

  // Losing fresh stock blocks the covered position everywhere instead of reading as healthy.
  const old = await f.db.owner.query(
    'SELECT id,document FROM inventory_snapshots WHERE tenant_id=$1 AND entity_id=$2',
    [f.actor.tenantId, positions[0].positionId],
  );
  await f.db.owner.query(
    "UPDATE inventory_snapshots SET document=jsonb_set(document,'{observedAt}',to_jsonb($3::text)) WHERE tenant_id=$1 AND entity_id=$2",
    [
      f.actor.tenantId,
      positions[0].positionId,
      new Date(Date.now() - 600000).toISOString(),
    ],
  );
  const stale = await summary();
  expect(stale.enablement).toBe('enabled');
  expect(stale.state).toBe(rules.length > 1 ? 'degraded' : 'blocked');
  expect(stale.coverage).toMatchObject({
    covered: rules.length,
    ready: rules.length - 1,
  });
  expect(stale.issues).toContainEqual(
    expect.objectContaining({
      code: 'stock_expired',
      repair: expect.objectContaining({
        destination: 'inventory_position',
        recordId: positions[0].positionId,
      }),
    }),
  );
  expect(
    (await coverage(positions[0].positionId)).json().items[0],
  ).toMatchObject({
    readiness: {
      state: 'blocked',
      coverage: { covered: 1, ready: 0 },
      nextAction: {
        repair: {
          destination: 'inventory_position',
          recordId: positions[0].positionId,
        },
      },
    },
  });
  expect(
    (await f.request('/replenishment')).rules.find(
      (rule) => rule.id === rules[0].id,
    ).status,
  ).toMatchObject({ state: 'blocked', code: 'expired' });
  for (const row of old.rows)
    await f.db.owner.query(
      'UPDATE inventory_snapshots SET document=$2 WHERE id=$1',
      [row.id, row.document],
    );

  // A waiting proposal becomes the next action and points at the exact decision.
  const run = await f.request('/replenishment/starts', {
    id: randomUUID(),
    activationId: rules[0].id,
  });
  await f.waitFor(run.id, 'awaiting_decision');
  const waiting = await summary();
  expect(waiting.waiting).toMatchObject({
    count: 1,
    repair: { destination: 'needs_you', recordId: `replenishment:${run.id}` },
  });
  expect(waiting.nextAction.label).toBe('Review 1 waiting decision');
  expect(
    (await coverage(positions[0].positionId)).json().items[0],
  ).toMatchObject({
    readiness: { waiting: { count: 1 } },
    latestRun: { runId: run.id },
  });

  // Members read readiness but can't preview or activate; other workspaces and unknown records 404.
  await f.db.owner.query(
    "UPDATE memberships SET role='member' WHERE tenant_id=$1 AND user_id=$2",
    [f.actor.tenantId, f.actor.actor.id],
  );
  expect(
    (await coverage(positions[0].positionId)).json().items[0].canManage,
  ).toBe(false);
  await f.request(
    '/replenishment/previews',
    { supplierId: f.supplier.id, items: [item(positions[0])] },
    { status: 403 },
  );
  await f.request(
    '/replenishment/activations/batch',
    { items: [{ ...rules[0], id: randomUUID() }] },
    { status: 403 },
  );
  await f.db.owner.query(
    "UPDATE memberships SET role='owner' WHERE tenant_id=$1 AND user_id=$2",
    [f.actor.tenantId, f.actor.actor.id],
  );
  expect((await coverage(randomUUID())).statusCode).toBe(404);
  const other = await f.pilot.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: { cookie: f.approverCookie, origin: 'http://127.0.0.1:3000' },
    payload: {
      name: 'Other workspace',
      slug: `other-${randomUUID()}`,
      dataRegion: globalThis.process.env.LUMA_REGION ?? 'AU',
    },
  });
  expect(other.statusCode, other.body).toBe(201);
  const isolated = await f.pilot.app.inject({
    url: `/v1/organizations/${other.json().id}/workflow-coverage?subjectKind=inventory_position&subjectId=${positions[0].positionId}`,
    headers: { cookie: f.approverCookie },
  });
  expect(isolated.statusCode, isolated.body).toBe(404);

  // Revoking every rule pauses the workflow; history stays.
  for (const rule of (await f.request('')).activations.filter((a) => a.active))
    await f.request(`/activations/${rule.id}/revoke`, {
      artifactDigest: rule.artifactDigest,
    });
  expect(await summary()).toMatchObject({
    enablement: 'paused',
    coverage: { covered: 0 },
  });
}, 120000);

it('keeps a proposal open for hours and rereads stock before creating the order', async (t) => {
  const f = await replenishmentFixture(t);
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

it('keeps rule readiness independent of stock choice search and pages', async (t) => {
  const f = await replenishmentFixture(t);
  const rule = await f.configure();
  const searched = await f.request('/replenishment?q=no-such-sku');
  expect(searched.positions).toEqual([]);
  expect(searched.nextCursor).toBeNull();
  expect(searched.rules).toMatchObject([
    {
      id: rule.id,
      stock: {
        positionId: f.position.positionId,
        connectionId: f.position.connectionId,
        available: f.position.available,
      },
      status: { state: 'ready' },
    },
  ]);
  const exact = await f.request(
    `/replenishment?positionId=${f.position.positionId}&connectionId=${f.position.connectionId}`,
  );
  expect(exact.positions).toEqual([f.position]);
  expect(exact.nextCursor).toBeNull();
  const missing = await f.request('/replenishment/previews', {
    supplierId: f.supplier.id,
    items: [
      {
        positionId: f.position.positionId,
        connectionId: randomUUID(),
        minimum: 1,
        target: 50,
        approvalQuantity: 20,
      },
    ],
  });
  expect(missing.items[0]).toMatchObject({
    outcome: 'covered',
    available: null,
  });
  await f.request('/replenishment?cursor=not-a-cursor', undefined, {
    status: 400,
  });
}, 120000);

it('reads watched stock once per monitor pass and rereads only a refreshed position', async (t) => {
  const f = await replenishmentFixture(t);
  const setup = await f.request('/replenishment');
  const chosen = setup.positions
    .filter(
      (p, index, all) =>
        all.findIndex((other) => other.positionId === p.positionId) === index,
    )
    .slice(0, 2);
  expect(chosen).toHaveLength(2);
  const detail = await f.request('');
  for (const position of chosen)
    await f.request('/replenishment/activations', {
      id: randomUUID(),
      positionId: position.positionId,
      connectionId: position.connectionId,
      supplierId: f.supplier.id,
      minimum: 0,
      target: 100,
      approvalQuantity: 20,
      reviewedDigest: detail.versions[0].digest,
    });
  const reads = [];
  const original = Client.prototype.query;
  const spy = vi.spyOn(Client.prototype, 'query').mockImplementation(function (
    ...args
  ) {
    const result = original.apply(this, args);
    if (
      typeof args[0] !== 'string' ||
      !args[0].includes('COALESCE((SELECT k.code FROM inventory_product_skus')
    )
      return result;

    return result.then((result) => {
      reads.push(
        result.rows.map((row) => ({
          positionId: row.position_id,
          connectionId: row.connection_id,
        })),
      );

      return result;
    });
  });
  t.onTestFinished(() => spy.mockRestore());
  await f.pilot.replenishment.tick(f.actor);
  expect(reads).toHaveLength(1);
  expect(reads[0]).toHaveLength(2);
  expect(reads[0]).toEqual(
    expect.arrayContaining(
      chosen.map(({ positionId, connectionId }) => ({
        positionId,
        connectionId,
      })),
    ),
  );
  reads.length = 0;
  await f.pilot.replenishment.tick(f.actor);
  expect(reads).toHaveLength(1);
  expect(reads[0]).toHaveLength(2);
  const old = new Date(Date.now() - 6 * 60_000).toISOString();
  await f.db.owner.query(
    `UPDATE inventory_snapshots SET observed_at=$3::timestamptz,document=jsonb_set(document,'{observedAt}',to_jsonb($3::text))
     WHERE tenant_id=$1 AND entity_id=$2`,
    [f.actor.tenantId, chosen[0].positionId, old],
  );
  reads.length = 0;
  await f.pilot.replenishment.tick(f.actor);
  expect(reads).toHaveLength(2);
  expect(reads[0]).toHaveLength(2);
  expect(reads[1]).toEqual([
    { positionId: chosen[0].positionId, connectionId: chosen[0].connectionId },
  ]);
  spy.mockRestore();
  expect((await f.request('/runs')).items).toEqual([]);
}, 120000);

it('lets the requester approve replenishment when the team independent approval preference is off', async (t) => {
  const f = await replenishmentFixture(t);
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
