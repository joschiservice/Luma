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
      body: {
        name: 'Other',
        slug: 'other',
        dataRegion: globalThis.process.env.LUMA_REGION ?? 'AU',
      },
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

it('filters, sorts and pages purchase orders and suppliers on the server within the workspace', async (t) => {
  const { api, owner, root } = await procurementFixture(t);
  const post = async (path, body, status = 200) =>
    (
      await api.request(`${root}${path}`, {
        cookie: owner.cookie,
        method: 'POST',
        body,
        status,
      })
    ).body;
  const get = async (path, query = {}, status = 200) =>
    (
      await api.request(`${root}${path}?${new URLSearchParams(query)}`, {
        cookie: owner.cookie,
        status,
      })
    ).body;
  const suppliers = [];
  for (const [name, system] of [
    ['Zephyr Textiles', 'JTL'],
    ['alpine Packaging', 'Xentral'],
    ['Meridian Goods', 'JTL'],
  ])
    suppliers.push(
      await post('/suppliers', {
        id: randomUUID(),
        name,
        externalReferences: [{ system, externalId: `${name.slice(0, 3)}-1` }],
      }),
    );
  const order = (reference, supplier, sku) =>
    post('/purchase-orders', {
      id: randomUUID(),
      supplierId: supplier.id,
      reference,
      lines: [
        {
          id: randomUUID(),
          sku,
          description: 'Tote',
          quantity: 5,
          unit: 'each',
        },
      ],
    });
  const orders = [];
  for (const [reference, supplier, sku] of [
    ['PO-003', suppliers[0], 'TOTE-NAT'],
    ['po-001', suppliers[1], 'TOTE-BLK'],
    ['PO-002', suppliers[0], 'BAG-100%'],
    ['PO-004', suppliers[2], 'TOTE-NAT'],
  ])
    orders.push(await order(reference, supplier, sku));
  const transition = (target, status, expectedRevision = 1) =>
    post(`/purchase-orders/${target.id}/transitions`, {
      id: randomUUID(),
      expectedRevision,
      status,
      reason: 'List review',
    });
  await transition(orders[2], 'cancelled');
  await transition(orders[3], 'open');
  await transition(orders[3], 'closed', 2);

  // Without query parameters the list returns the newest first page with workspace counts.
  const first = await get('/purchase-orders');
  expect(first.items).toHaveLength(4);
  const created = first.items.map((item) => item.createdAt);
  expect(created).toEqual([...created].sort().reverse());
  expect(
    first.items.find((item) => item.id === orders[3].id).summary,
  ).toMatchObject({ id: orders[3].id, stage: 'closed' });
  expect(first.counts).toEqual({
    all: 4,
    attention: 0,
    stages: { draft: 2, cancelled: 1, closed: 1 },
  });
  expect(first.totalCount).toBeNull();
  expect(first.nextCursor).toBeNull();

  // Search matches references, supplier names and line SKUs literally, ignoring case.
  const search = async (q) =>
    (await get('/purchase-orders', { q })).items.map((item) => item.reference);
  expect(await search('tote-nat')).toEqual(['PO-004', 'PO-003']);
  expect(await search('ALPINE')).toEqual(['po-001']);
  expect(await search('100%')).toEqual(['PO-002']);
  expect(await search('%')).toEqual(['PO-002']);
  const filtered = await get('/purchase-orders', {
    supplierId: suppliers[0].id,
    status: 'draft',
    count: 'exact',
  });
  expect(filtered.items.map((item) => item.reference)).toEqual(['PO-003']);
  expect(filtered).toMatchObject({ totalCount: 1, counts: null });
  // Stages come from the same progress rules as the order record.
  const stage = await get('/purchase-orders', {
    stage: 'draft',
    sort: 'reference',
    count: 'exact',
  });
  expect(stage.items.map((item) => item.reference)).toEqual([
    'po-001',
    'PO-003',
  ]);
  expect(stage.totalCount).toBe(2);
  expect((await get('/purchase-orders', { stage: 'attention' })).items).toEqual(
    [],
  );

  // Keyset pages follow the requested order and stay bound to their filters.
  const pages = [];
  let cursor;
  do {
    const page = await get('/purchase-orders', {
      sort: 'supplier',
      direction: 'desc',
      limit: '1',
      count: 'exact',
      ...(cursor ? { cursor } : {}),
    });
    expect(page.totalCount).toBe(4);
    pages.push(page.items[0].supplierName);
    cursor = page.nextCursor;
  } while (cursor);
  expect(pages).toEqual([
    'Zephyr Textiles',
    'Zephyr Textiles',
    'Meridian Goods',
    'alpine Packaging',
  ]);
  const staged = await get('/purchase-orders', {
    stage: 'draft',
    sort: 'expected',
    limit: '1',
    count: 'exact',
  });
  expect(staged.totalCount).toBe(2);
  const next = await get('/purchase-orders', {
    stage: 'draft',
    sort: 'expected',
    limit: '1',
    count: 'exact',
    cursor: staged.nextCursor,
  });
  expect(next.totalCount).toBe(2);
  expect(next.nextCursor).toBeNull();
  expect(new Set([staged.items[0].id, next.items[0].id])).toEqual(
    new Set([orders[0].id, orders[1].id]),
  );
  const mismatched = await get(
    '/purchase-orders',
    { stage: 'cancelled', sort: 'expected', cursor: staged.nextCursor },
    400,
  );
  expect(mismatched.message).toMatch(/first page/);
  await get('/purchase-orders', { cursor: 'not-a-cursor' }, 400);
  await get('/purchase-orders', { limit: '51' }, 400);
  await get('/purchase-orders', { stage: 'unknown' }, 400);

  // Suppliers sort by name, creation or order count and include their order counts.
  const directory = await get('/suppliers', { count: 'exact' });
  expect(directory.items.map((item) => [item.name, item.orderCount])).toEqual([
    ['alpine Packaging', 1],
    ['Meridian Goods', 1],
    ['Zephyr Textiles', 2],
  ]);
  expect(directory.totalCount).toBe(3);
  const busiest = await get('/suppliers', { sort: 'orders', limit: '1' });
  expect(busiest.items.map((item) => item.name)).toEqual(['Zephyr Textiles']);
  const rest = await get('/suppliers', {
    sort: 'orders',
    limit: '2',
    cursor: busiest.nextCursor,
  });
  expect(rest.items.map((item) => item.orderCount)).toEqual([1, 1]);
  expect(rest.nextCursor).toBeNull();
  expect(
    (await get('/suppliers', { q: 'xentral' })).items.map((item) => item.name),
  ).toEqual(['alpine Packaging']);
  await get('/suppliers', { sort: 'name', cursor: busiest.nextCursor }, 400);

  // Another workspace's members see neither its records nor a usable cursor.
  const outsider = await signup(api, 'procurement-list-outsider');
  const other = (
    await api.request('/v1/organizations', {
      cookie: outsider.cookie,
      method: 'POST',
      status: 201,
      body: {
        name: 'Other',
        slug: 'other-list',
        dataRegion: globalThis.process.env.LUMA_REGION ?? 'AU',
      },
    })
  ).body;
  const otherRoot = `/v1/organizations/${other.id}/procurement`;
  const empty = (
    await api.request(`${otherRoot}/purchase-orders`, {
      cookie: outsider.cookie,
    })
  ).body;
  expect(empty).toMatchObject({
    items: [],
    counts: { all: 0, attention: 0, stages: {} },
  });
  expect(
    (await api.request(`${otherRoot}/suppliers`, { cookie: outsider.cookie }))
      .body.items,
  ).toEqual([]);
  await api.request(
    `${otherRoot}/suppliers?${new URLSearchParams({ sort: 'orders', cursor: busiest.nextCursor })}`,
    { cookie: outsider.cookie, status: 400 },
  );
  await api.request(`${root}/purchase-orders`, {
    cookie: outsider.cookie,
    status: 404,
  });
});

it('filters, groups and pages purchase orders and suppliers by catalog conditions', async (t) => {
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
  const encode = (query) =>
    new URLSearchParams(
      Object.entries(query).map(([key, value]) => [
        key,
        typeof value === 'object' ? JSON.stringify(value) : String(value),
      ]),
    );
  const get = async (path, query = {}, status = 200) =>
    (
      await api.request(`${root}${path}?${encode(query)}`, {
        cookie: owner.cookie,
        status,
      })
    ).body;
  const orders = (query, status) => get('/purchase-orders', query, status);
  const all = (...conditions) => ({ match: 'all', conditions });
  const any = (...conditions) => ({ match: 'any', conditions });
  const refs = (page) => page.items.map((item) => item.reference).sort();
  const day = 86_400_000;
  const iso = (offset) => new Date(Date.now() + offset).toISOString();

  const supplier = async (name) =>
    post('/suppliers', { id: randomUUID(), name, externalReferences: [] });
  const [acme, birch, cobalt, delta] = [
    await supplier('Acme Bags'),
    await supplier('birch Goods'),
    await supplier('Cobalt Supply'),
    await supplier('Delta Idle'),
  ];
  const warehouse = randomUUID();
  const line = (sku, quantity, unitPrice, locationId) => ({
    id: randomUUID(),
    sku,
    description: sku,
    quantity,
    unit: 'each',
    ...(unitPrice ? { unitPrice } : {}),
    ...(locationId ? { locationId } : {}),
  });
  const order = (reference, by, lines, extra = {}) =>
    post('/purchase-orders', {
      id: randomUUID(),
      supplierId: by.id,
      reference,
      lines,
      ...extra,
    });
  const transition = (target, status, expectedRevision = 1) =>
    post(`/purchase-orders/${target.id}/transitions`, {
      id: randomUUID(),
      expectedRevision,
      status,
      reason: 'List review',
    });
  // A verified submission, as the purchasing system path records it.
  const submit = async (target, submittedAt) => {
    const id = randomUUID();
    const document = {
      id,
      tenantId: org.id,
      purchaseOrderId: target.id,
      connectionId: randomUUID(),
      supplier: { externalId: '1', scopeKey: '' },
      requestedDeliveryDate: iso(30 * day).slice(0, 10),
      lines: [],
      actionId: 'action',
      decisionId: randomUUID(),
      requestedBy: owner.userId,
      requestedAt: submittedAt,
      expiresAt: submittedAt,
      state: 'submitted',
      externalOrder: { externalId: target.id, orderNumber: target.reference },
      submittedAt,
      decidedBy: owner.userId,
      decidedAt: submittedAt,
      failure: null,
      updatedAt: submittedAt,
    };
    await db.owner.query(
      'INSERT INTO procurement_submissions(tenant_id,id,purchase_order_id,connection_id,state,principal_id,document,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        org.id,
        id,
        target.id,
        document.connectionId,
        'submitted',
        owner.userId,
        document,
        submittedAt,
      ],
    );
  };

  const eur = (amount) => ({ amount, currency: 'EUR' });
  const draft = await order('PO-DRAFT', acme, [
    line('TOTE-NAT', 10, eur('2.50'), warehouse),
  ]);
  const overdue = await order('PO-OVERDUE', acme, [
    line('BAG-1', 1, eur('100')),
  ]);
  const waiting = await order('PO-WAITING', birch, [line('TOTE-BLK', 4)]);
  const cancelled = await order('PO-CANCELLED', birch, [
    line('CUP-1', 1, eur('3')),
    line('CUP-2', 1),
  ]);
  await order(
    'PO-EXTERNAL',
    cobalt,
    [line('LID-1', 8, { amount: '5', currency: 'USD' })],
    {
      authority: 'external',
      externalReferences: [{ system: 'ERP', externalId: 'E-1' }],
    },
  );
  const followed = await order('PO-FOLLOWED', birch, [line('BOX-1', 2)]);
  for (const target of [overdue, waiting, followed])
    await transition(target, 'open');
  await transition(cancelled, 'cancelled');
  await submit(overdue, iso(-5 * day));
  await submit(waiting, iso(-3_600_000));
  await submit(followed, iso(-5 * day));
  // The draft is older than a week.
  const tenDaysAgo = iso(-10 * day);
  await db.owner.query(
    `UPDATE procurement_purchase_orders SET created_at=$3,document=jsonb_set(document,'{createdAt}',to_jsonb($4::text))
     WHERE tenant_id=$1 AND id=$2`,
    [org.id, draft.id, tenDaysAgo, tenDaysAgo],
  );
  await db.owner.query(
    `UPDATE procurement_suppliers SET document=jsonb_set(document,'{createdAt}',to_jsonb($3::text))
     WHERE tenant_id=$1 AND id=$2`,
    [org.id, delta.id, tenDaysAgo],
  );
  // Following up on the missed confirmation hides it until the next check.
  const nextCheck = iso(day);
  const [followedSummary] = (
    await orders({
      where: all({ field: 'reference', op: 'is', value: 'PO-FOLLOWED' }),
    })
  ).items.map((item) => item.summary);
  expect(followedSummary.attentionKinds).toEqual(['confirmation_overdue']);
  await post(`/purchase-orders/${followed.id}/follow-ups`, {
    id: randomUUID(),
    key: `confirmation_overdue:${followed.id}:${followedSummary.confirmationDueAt}`,
    response: 'following_up',
    note: 'Called the supplier',
    nextCheckAt: nextCheck,
  });

  // Stored and derived conditions combine; counts are exact.
  const mixed = await orders({
    where: all(
      { field: 'supplier', op: 'any_of', value: [acme.id, birch.id] },
      {
        field: 'stage',
        op: 'any_of',
        value: ['draft', 'awaiting_confirmation'],
      },
    ),
    count: 'exact',
  });
  expect(refs(mixed)).toEqual([
    'PO-DRAFT',
    'PO-FOLLOWED',
    'PO-OVERDUE',
    'PO-WAITING',
  ]);
  expect(mixed).toMatchObject({ totalCount: 4, counts: null });
  const attention = await orders({
    where: all({
      field: 'attention',
      op: 'any_of',
      value: ['confirmation_overdue'],
    }),
  });
  expect(refs(attention)).toEqual(['PO-OVERDUE']);
  expect(attention.items[0].summary).toMatchObject({
    stage: 'awaiting_confirmation',
    nextOwner: 'buyer',
    attentionKinds: ['confirmation_overdue'],
    value: { amount: '100', currency: 'EUR' },
  });
  // `not_empty` is the legacy attention stage.
  expect(
    refs(await orders({ where: all({ field: 'attention', op: 'not_empty' }) })),
  ).toEqual(refs(await orders({ stage: 'attention' })));
  expect(
    refs(
      await orders({
        where: all({ field: 'nextOwner', op: 'any_of', value: ['supplier'] }),
      }),
    ),
  ).toEqual(['PO-FOLLOWED', 'PO-WAITING']);
  const checks = await orders({
    where: all({
      field: 'nextCheck',
      op: 'within_next',
      value: { amount: 2, unit: 'day' },
    }),
  });
  expect(refs(checks)).toEqual(['PO-FOLLOWED']);
  expect(Date.parse(checks.items[0].summary.nextCheckAt)).toBe(
    Date.parse(nextCheck),
  );
  expect(
    refs(
      await orders({
        where: all({
          field: 'created',
          op: 'within_last',
          value: { amount: 7, unit: 'day' },
        }),
        timeZone: 'Europe/Berlin',
      }),
    ),
  ).toEqual([
    'PO-CANCELLED',
    'PO-EXTERNAL',
    'PO-FOLLOWED',
    'PO-OVERDUE',
    'PO-WAITING',
  ]);
  expect(
    refs(
      await orders({
        where: all({
          field: 'created',
          op: 'between',
          value: { from: null, to: iso(-7 * day) },
        }),
      }),
    ),
  ).toEqual(['PO-DRAFT']);
  expect(
    refs(
      await orders({
        where: all({
          field: 'value',
          op: 'between',
          value: { from: eur('20'), to: eur('50') },
        }),
      }),
    ),
  ).toEqual(['PO-DRAFT']);
  expect(
    refs(await orders({ where: all({ field: 'value', op: 'unknown' }) })),
  ).toEqual(['PO-CANCELLED']);
  expect(
    refs(await orders({ where: all({ field: 'value', op: 'empty' }) })),
  ).toEqual(['PO-FOLLOWED', 'PO-WAITING']);
  expect(
    refs(
      await orders({
        where: all({ field: 'sku', op: 'contains', value: 'tote' }),
      }),
    ),
  ).toEqual(['PO-DRAFT', 'PO-WAITING']);
  expect(
    refs(
      await orders({
        where: all({ field: 'location', op: 'any_of', value: [warehouse] }),
      }),
    ),
  ).toEqual(['PO-DRAFT']);
  expect(
    refs(
      await orders({
        where: all({ field: 'authority', op: 'any_of', value: ['external'] }),
      }),
    ),
  ).toEqual(['PO-EXTERNAL']);
  // Match any, with stored conditions only and mixed with derived ones.
  expect(
    refs(
      await orders({
        where: any(
          { field: 'supplier', op: 'any_of', value: [cobalt.id] },
          { field: 'sku', op: 'contains', value: 'BAG' },
        ),
      }),
    ),
  ).toEqual(['PO-EXTERNAL', 'PO-OVERDUE']);
  expect(
    refs(
      await orders({
        where: any(
          { field: 'stage', op: 'any_of', value: ['cancelled'] },
          { field: 'sku', op: 'contains', value: 'BAG' },
        ),
        count: 'exact',
      }),
    ),
  ).toEqual(['PO-CANCELLED', 'PO-OVERDUE']);

  // Derived sorts compare typed values; orders without a value come last.
  const byValue = await orders({ sort: 'value', limit: 2 });
  expect(byValue.items.map((item) => item.reference)).toEqual([
    'PO-DRAFT',
    'PO-OVERDUE',
  ]);
  const valuePages = [byValue.items];
  for (let cursor = byValue.nextCursor; cursor;) {
    const page = await orders({ sort: 'value', limit: 2, cursor });
    valuePages.push(page.items);
    cursor = page.nextCursor;
  }
  expect(
    valuePages
      .flat()
      .map((item) => item.reference)
      .slice(0, 3),
  ).toEqual(['PO-DRAFT', 'PO-OVERDUE', 'PO-EXTERNAL']);
  expect(valuePages.flat()).toHaveLength(6);
  expect(
    (await orders({ sort: 'nextCheck', limit: 1 })).items[0].reference,
  ).toBe('PO-FOLLOWED');

  // Groups count every match and page within one group through its cursor.
  const bySupplier = await orders({ group: 'supplier', groupLimit: 1 });
  expect(
    bySupplier.groups.map((group) => [group.key, group.count, group.complete]),
  ).toEqual([
    [acme.id, 2, true],
    [birch.id, 3, true],
    [cobalt.id, 1, true],
  ]);
  expect(bySupplier).toMatchObject({
    nextCursor: null,
    groupsTruncated: false,
    counts: null,
  });
  expect(bySupplier.items).toHaveLength(3);
  const birchGroup = bySupplier.groups[1];
  expect(birchGroup.nextCursor).toEqual(expect.any(String));
  const birchRest = await orders({
    group: 'supplier',
    groupKey: JSON.stringify(birch.id),
    limit: 5,
    cursor: birchGroup.nextCursor,
  });
  expect(birchRest.items).toHaveLength(2);
  expect(birchRest.groups).toEqual([
    expect.objectContaining({
      key: birch.id,
      count: 3,
      nextCursor: null,
      itemIds: birchRest.items.map((item) => item.id),
    }),
  ]);
  expect(
    new Set([...birchGroup.itemIds, ...birchRest.groups[0].itemIds]),
  ).toEqual(new Set([waiting.id, cancelled.id, followed.id]));
  const byStage = await orders({ group: 'stage' });
  expect(byStage.groups.map((group) => [group.key, group.count])).toEqual([
    ['draft', 2],
    ['awaiting_confirmation', 3],
    ['cancelled', 1],
  ]);
  expect(byStage.groups[0].sums).toEqual([
    { field: 'value', currency: 'EUR', amount: '25' },
    { field: 'value', currency: 'USD', amount: '40' },
  ]);
  const byOwner = await orders({
    group: 'nextOwner',
    where: all({ field: 'status', op: 'none_of', value: ['cancelled'] }),
  });
  expect(byOwner.groups.map((group) => [group.key, group.count])).toEqual([
    ['buyer', 3],
    ['supplier', 2],
  ]);

  // Invalid requests and cursors from another query are refused.
  const refused = async (query, message) =>
    expect((await orders(query, 400)).message).toMatch(message);
  await refused(
    { where: all({ field: 'stage', op: 'contains', value: 'draft' }) },
    'Condition 1: This field does not support this operator.',
  );
  await refused(
    { where: all({ field: 'supplier', op: 'any_of', value: ['nope'] }) },
    'Condition 1: This value is not a valid record ID.',
  );
  await refused({ group: 'expected' }, 'This field cannot be grouped.');
  await refused(
    { groupKey: JSON.stringify('draft') },
    'Choose a grouping to read one group.',
  );
  await refused(
    { group: 'supplier', cursor: birchGroup.nextCursor },
    'group key',
  );
  const narrow = all({
    field: 'stage',
    op: 'any_of',
    value: ['awaiting_confirmation'],
  });
  const firstPage = await orders({ where: narrow, limit: 1 });
  expect(firstPage.nextCursor).toEqual(expect.any(String));
  await refused(
    {
      where: all({ field: 'stage', op: 'any_of', value: ['draft'] }),
      limit: 1,
      cursor: firstPage.nextCursor,
    },
    'first page',
  );
  await refused(
    {
      group: 'supplier',
      groupKey: JSON.stringify(acme.id),
      cursor: birchGroup.nextCursor,
    },
    'first page',
  );

  // Supplier conditions: open orders, overdue confirmations and creation dates.
  const suppliers = (where) =>
    get('/suppliers', { where }).then((page) =>
      page.items.map((item) => item.name),
    );
  expect(
    await suppliers(all({ field: 'hasOpenOrders', op: 'is', value: true })),
  ).toEqual(['Acme Bags', 'birch Goods']);
  expect(
    await suppliers(
      all({ field: 'confirmationOverdue', op: 'is', value: true }),
    ),
  ).toEqual(['Acme Bags']);
  expect(
    await suppliers(
      any(
        { field: 'hasOpenOrders', op: 'is', value: false },
        { field: 'confirmationOverdue', op: 'is', value: true },
      ),
    ),
  ).toEqual(['Acme Bags', 'Cobalt Supply', 'Delta Idle']);
  expect(
    await suppliers(
      all({ field: 'created', op: 'before', value: { dynamic: 'today' } }),
    ),
  ).toEqual(['Delta Idle']);
  expect(
    (
      await get(
        '/suppliers',
        { where: all({ field: 'name', op: 'contains', value: 'a' }) },
        400,
      )
    ).message,
  ).toBe('Condition 1: This field cannot be filtered.');

  // Another workspace sees none of these records and cannot continue their groups.
  const outsider = await signup(api, 'procurement-conditions-outsider');
  const other = (
    await api.request('/v1/organizations', {
      cookie: outsider.cookie,
      method: 'POST',
      status: 201,
      body: {
        name: 'Other',
        slug: 'other-conditions',
        dataRegion: globalThis.process.env.LUMA_REGION ?? 'AU',
      },
    })
  ).body;
  const otherRoot = `/v1/organizations/${other.id}/procurement`;
  const otherOrders = (query, status = 200) =>
    api
      .request(`${otherRoot}/purchase-orders?${encode(query)}`, {
        cookie: outsider.cookie,
        status,
      })
      .then((response) => response.body);
  expect(
    (
      await otherOrders({
        where: all({ field: 'supplier', op: 'any_of', value: [acme.id] }),
      })
    ).items,
  ).toEqual([]);
  expect((await otherOrders({ group: 'supplier' })).groups).toEqual([]);
  await otherOrders(
    {
      group: 'supplier',
      groupKey: JSON.stringify(birch.id),
      cursor: birchGroup.nextCursor,
    },
    400,
  );
});
