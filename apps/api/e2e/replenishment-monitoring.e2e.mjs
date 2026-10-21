import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { expect, it, vi } from 'vitest';

import { replenishmentFixture } from './replenishment-fixture.mjs';

it('deduplicates monitored conditions and isolates rules, reviews and decisions by current membership', async (t) => {
  const f = await replenishmentFixture(t, undefined, { imported: true });
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
  const f = await replenishmentFixture(t, undefined, { imported: true });
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

it('keeps rule readiness independent of stock choice search and pages', async (t) => {
  const f = await replenishmentFixture(t, undefined, { imported: true });
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
  const f = await replenishmentFixture(t, undefined, { imported: true });
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
