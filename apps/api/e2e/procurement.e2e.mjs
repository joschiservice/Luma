import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { expect, it } from 'vitest';

import { signup } from './helpers.mjs';
import { procurementFixture } from './procurement-fixture.mjs';

it('persists authoritative orders with atomic audit, exact retries, tenant isolation and explicit lifecycle', async (t) => {
  const { db, api, owner, org, root } = await procurementFixture(t);
  const post = async (path, body, status = 200) =>
    (
      await api.request(`${root}${path}`, {
        cookie: owner.cookie,
        method: 'POST',
        body,
        status,
      })
    ).body;
  const get = async (path, status = 200, cookie = owner.cookie) =>
    (await api.request(`${root}${path}`, { cookie, status })).body;
  const supplier = {
    id: randomUUID(),
    name: 'Northstar Supply',
    externalReferences: [{ system: 'JTL', externalId: 'SUP-42' }],
  };
  expect(await post('/suppliers', supplier)).toMatchObject({
    ...supplier,
    tenantId: org.id,
  });
  const request = {
    id: randomUUID(),
    supplierId: supplier.id,
    reference: 'PO-001',
    lines: [
      {
        id: randomUUID(),
        sku: 'SKU-1',
        description: 'Cotton tote',
        quantity: 12,
        unit: 'each',
      },
    ],
    origin: {
      workflowRunId: randomUUID(),
      actionId: 'action-1',
      outcomeId: 'outcome-1',
    },
    externalReferences: [{ system: 'JTL', externalId: 'PO-42' }],
  };
  const [created, retried] = await Promise.all([
    post('/purchase-orders', request),
    post('/purchase-orders', request),
  ]);
  expect(created).toEqual(retried);
  expect(created).toMatchObject({
    status: 'draft',
    authority: 'luma',
    revision: 1,
    origin: request.origin,
  });
  await post('/purchase-orders', { ...request, reference: 'different' }, 409);
  const path = `/purchase-orders/${request.id}`;
  expect((await get(path)).history).toHaveLength(1);
  const open = {
    id: randomUUID(),
    expectedRevision: 1,
    status: 'open',
    reason: 'Supplier and quantities reviewed',
  };
  expect(await post(`${path}/transitions`, open)).toMatchObject({
    status: 'open',
    revision: 2,
  });
  expect(await post(`${path}/transitions`, open)).toMatchObject({
    status: 'open',
    revision: 2,
  });
  await post(`${path}/transitions`, { ...open, id: randomUUID() }, 409);
  await post(
    `${path}/transitions`,
    { ...open, id: randomUUID(), expectedRevision: 2, status: 'draft' },
    409,
  );
  const detail = await get(path);
  expect(
    detail.history.map((event) => [event.from, event.to, event.revision]),
  ).toEqual([
    [null, 'draft', 1],
    ['draft', 'open', 2],
  ]);
  expect(detail.history[1]).toMatchObject({
    reason: open.reason,
    actorId: owner.userId,
  });
  expect(detail.allowedTransitions).toEqual(['closed', 'cancelled']);
  expect((await get('/purchase-orders')).items).toHaveLength(1);
  await post(`${path}/transitions`, {
    id: randomUUID(),
    expectedRevision: 2,
    status: 'closed',
    reason: 'Procurement complete',
  });
  expect((await get(path)).allowedTransitions).toEqual([]);
  await post(
    `${path}/transitions`,
    { id: randomUUID(), expectedRevision: 3, status: 'open', reason: 'Reopen' },
    409,
  );
  // Retrying an earlier command returns its original result, without reverting the live order.
  expect(await post('/purchase-orders', request)).toEqual(created);
  expect((await get(path)).order.status).toBe('closed');
  expect((await get(path)).history).toHaveLength(3);
  await post(
    '/purchase-orders',
    { ...request, id: randomUUID(), supplierId: randomUUID() },
    404,
  );
  await post(
    '/purchase-orders',
    {
      ...request,
      id: randomUUID(),
      lines: [request.lines[0], request.lines[0]],
    },
    409,
  );
  for (const quantity of [0, -1])
    await post(
      '/purchase-orders',
      {
        ...request,
        id: randomUUID(),
        lines: [{ ...request.lines[0], quantity }],
      },
      400,
    );
  await post(
    '/purchase-orders',
    { ...request, id: randomUUID(), lines: [] },
    400,
  );
  await post(
    '/purchase-orders',
    {
      ...request,
      id: randomUUID(),
      authority: 'external',
      externalReferences: [],
    },
    409,
  );
  const external = await post('/purchase-orders', {
    ...request,
    id: randomUUID(),
    authority: 'external',
  });
  expect(
    (await get(`/purchase-orders/${external.id}`)).allowedTransitions,
  ).toEqual([]);
  await post(
    `/purchase-orders/${external.id}/transitions`,
    { ...open, id: randomUUID() },
    409,
  );
  const outsider = await signup(api, 'procurement-outsider');
  await get(path, 404, outsider.cookie);
  const other = (
    await api.request('/v1/organizations', {
      cookie: outsider.cookie,
      method: 'POST',
      status: 201,
      body: { name: 'Other', slug: 'other', dataRegion: 'EU' },
    })
  ).body;
  await api.request(
    `/v1/organizations/${other.id}/procurement/purchase-orders/${request.id}`,
    { cookie: outsider.cookie, status: 404 },
  );
  await api.request(
    `/v1/organizations/${other.id}/procurement/purchase-orders`,
    {
      cookie: outsider.cookie,
      method: 'POST',
      status: 404,
      body: { ...request, id: randomUUID() },
    },
  );
  // RLS applies even when a query omits a tenant predicate.
  const runtime = new Pool({ connectionString: db.runtimeUrl });
  t.onTestFinished(() => runtime.end());
  const tx = await runtime.connect();
  try {
    await tx.query('BEGIN');
    await tx.query("SELECT set_config('app.tenant_id',$1,true)", [other.id]);
    expect(
      (await tx.query('SELECT * FROM procurement_purchase_orders')).rows,
    ).toEqual([]);
    await expect(
      tx.query(
        'INSERT INTO procurement_suppliers(tenant_id,id,document) VALUES($1,$2,$3)',
        [org.id, randomUUID(), {}],
      ),
    ).rejects.toThrow();
    await tx.query('ROLLBACK');
  } finally {
    tx.release();
  }
  // A failed audit append must roll back both the business record and retry command.
  const rollbackId = randomUUID();
  await db.owner.query(
    `CREATE FUNCTION reject_procurement_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.document->>'eventType'='purchase_order.created' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_procurement_audit BEFORE INSERT ON audit_entries FOR EACH ROW EXECUTE FUNCTION reject_procurement_audit()`,
  );
  await post('/purchase-orders', { ...request, id: rollbackId }, 500);
  expect(
    (
      await db.owner.query(
        'SELECT id FROM procurement_purchase_orders WHERE id=$1',
        [rollbackId],
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await db.owner.query('SELECT id FROM procurement_commands WHERE id=$1', [
        rollbackId,
      ])
    ).rows,
  ).toEqual([]);
  await db.owner.query(
    'DROP TRIGGER reject_procurement_audit ON audit_entries; DROP FUNCTION reject_procurement_audit()',
  );
  await post('/purchase-orders', { ...request, id: rollbackId });
  // Different commands racing on one revision produce exactly one transition.
  const raceOrder = await post('/purchase-orders', {
    ...request,
    id: randomUUID(),
  });
  const raceResponses = await Promise.all(
    ['open', 'cancelled'].map((status) =>
      fetch(
        `${api.origin}${root}/purchase-orders/${raceOrder.id}/transitions`,
        {
          method: 'POST',
          headers: {
            cookie: owner.cookie,
            origin: 'http://localhost:3000',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            id: randomUUID(),
            expectedRevision: 1,
            status,
            reason: 'Concurrent review',
          }),
        },
      ),
    ),
  );
  expect(raceResponses.map((response) => response.status).sort()).toEqual([
    200, 409,
  ]);
  expect((await get(`/purchase-orders/${raceOrder.id}`)).history).toHaveLength(
    2,
  );
  // An audit failure also rolls back a lifecycle update and permits the exact retry.
  const rollbackTransition = {
    id: randomUUID(),
    expectedRevision: 1,
    status: 'open',
    reason: 'Review complete',
  };
  await db.owner.query(
    `CREATE FUNCTION reject_procurement_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.document->>'eventType'='purchase_order.status_changed' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_procurement_transition BEFORE INSERT ON audit_entries FOR EACH ROW EXECUTE FUNCTION reject_procurement_transition()`,
  );
  await post(
    `/purchase-orders/${rollbackId}/transitions`,
    rollbackTransition,
    500,
  );
  expect((await get(`/purchase-orders/${rollbackId}`)).order).toMatchObject({
    status: 'draft',
    revision: 1,
  });
  expect(
    (
      await db.owner.query('SELECT id FROM procurement_commands WHERE id=$1', [
        rollbackTransition.id,
      ])
    ).rows,
  ).toEqual([]);
  await db.owner.query(
    'DROP TRIGGER reject_procurement_transition ON audit_entries; DROP FUNCTION reject_procurement_transition()',
  );
  await post(`/purchase-orders/${rollbackId}/transitions`, rollbackTransition);
  const activityQuery = new URLSearchParams({
    from: new Date(Date.now() - 86400000).toISOString(),
    to: new Date(Date.now() + 86400000).toISOString(),
    type: 'procurement',
  });
  const activity = (
    await api.request(`/v1/organizations/${org.id}/activity?${activityQuery}`, {
      cookie: owner.cookie,
    })
  ).body;
  expect(activity.items.length).toBeGreaterThan(0);
  expect(
    activity.items.every(
      (event) =>
        event.type === 'procurement' &&
        event.resource &&
        event.outcome === 'recorded',
    ),
  ).toBe(true);
  expect(
    activity.items.find((event) => event.proposalId === request.id),
  ).toMatchObject({ resource: request.id, type: 'procurement' });
  // Current membership governs every request, including command retries.
  await db.owner.query(
    "UPDATE memberships SET role='member' WHERE tenant_id=$1 AND user_id=$2",
    [org.id, owner.userId],
  );
  expect((await get(path)).canManage).toBe(false);
  expect((await get('/suppliers')).canManage).toBe(false);
  await post('/suppliers', supplier, 403);
  await post('/purchase-orders', request, 403);
  await post(`${path}/transitions`, open, 403);
  await db.owner.query(
    'DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2',
    [org.id, owner.userId],
  );
  await get(path, 404);
});
