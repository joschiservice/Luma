import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { returnsFixture } from './returns-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

it('follows imported returns by stage and never counts a requested refund as money returned', async (t) => {
  const f = await settingsFixture(t);
  const r = await returnsFixture(t, f);
  const all = await f.request(f.member, `${f.base}/returns?view=all`);
  expect(all.counts.views).toEqual({ action: 1, waiting: 1, done: 2, all: 4 });
  // Every stage is counted, including empty ones.
  expect(
    Object.entries(all.counts.stages).filter(([, count]) => count),
  ).toEqual([
    ['requested', 1],
    ['refund_pending', 1],
    ['closed', 1],
    ['refunded', 1],
  ]);
  expect(Object.keys(all.counts.stages)).toHaveLength(12);
  // Newest request first by default.
  expect(all.items.map((item) => [item.name, item.stage])).toEqual([
    [null, 'refunded'],
    ['#1001-R1', 'requested'],
    ['#1002-R1', 'refund_pending'],
    ['#1003-R1', 'closed'],
  ]);
  const pending = all.items.find((item) => item.name === '#1002-R1');
  expect(pending).toMatchObject({
    kind: 'return',
    externalId: 'gid://shopify/Return/1002',
    order: { id: r.orders[1002], displayNumber: '#1002' },
    status: 'open',
    group: 'waiting',
    quantity: '2',
    received: '2',
    reasons: ['Defective'],
    value: { amount: '48', currency: 'EUR' },
    // The failed and the pending payment returned no money.
    refund: {
      state: 'pending',
      currency: 'EUR',
      refunded: null,
      pending: '48',
      failedAttempts: 1,
    },
  });
  expect(all.items.find((item) => item.name === '#1003-R1').refund).toEqual({
    state: 'refunded',
    currency: 'EUR',
    refunded: '48',
    pending: null,
    failedAttempts: 0,
  });
  expect(all.items[0]).toMatchObject({
    kind: 'refund',
    id: r.refunds.goodwill,
    refund: { state: 'refunded', refunded: '5' },
  });
  expect(
    all.sources.map((source) => [source.label, source.access, source.records]),
  ).toEqual([
    ['JTL-Wawi', 'not_requested', 0],
    ['Tokyo store', 'granted', 4],
  ]);

  // Pending work opens oldest first; stages and searches narrow the list.
  const action = await f.request(
    f.member,
    `${f.base}/returns?view=action&direction=asc`,
  );
  expect(action.items.map((item) => item.name)).toEqual(['#1001-R1']);
  // Value sorts compare amounts within a currency; returns without a value come last.
  const values = (
    await f.request(f.member, `${f.base}/returns?view=all&sort=value`)
  ).items.map((item) => item.value);
  const valued = values.filter((value) => value !== null);
  expect(valued).toEqual(
    [...valued].sort(
      (a, b) =>
        b.currency.localeCompare(a.currency) ||
        Number(b.amount) - Number(a.amount),
    ),
  );
  expect(values.slice(valued.length).every((value) => value === null)).toBe(
    true,
  );
  const stages = (
    await f.request(
      f.member,
      `${f.base}/returns?view=all&sort=stage&direction=asc`,
    )
  ).items.map((item) => item.stage);
  const lifecycle = [
    'requested',
    'awaiting_items',
    'awaiting_refund',
    'refund_pending',
    'refund_failed',
    'ready_to_close',
    'refunded',
    'refund_recorded',
    'closed',
    'declined',
    'cancelled',
    'unknown',
  ];
  expect(stages).toEqual(
    [...stages].sort((a, b) => lifecycle.indexOf(a) - lifecycle.indexOf(b)),
  );
  expect(
    (await f.request(f.member, `${f.base}/returns?stage=closed`)).items.map(
      (item) => item.name,
    ),
  ).toEqual(['#1003-R1']);
  for (const [q, expected] of [
    ['#1002', 2],
    ['defective', 1],
    ['gid://shopify/Refund/2003', 1],
    ['gid://shopify/Order/1003', 1],
    ['%', 0],
  ])
    expect(
      (
        await f.request(
          f.member,
          `${f.base}/returns?q=${encodeURIComponent(q)}`,
        )
      ).items,
      q,
    ).toHaveLength(expected);

  // The detail keeps every payment attempt and the order context.
  const detail = await f.request(
    f.member,
    `${f.base}/returns/${r.returns.received}`,
  );
  expect(detail.lines).toEqual([
    expect.objectContaining({
      title: 'Canvas tote',
      skuCode: 'TOTE-RED',
      quantity: '2',
      reason: 'Defective',
      received: '2',
      restocked: '2',
      refunded: '2',
    }),
  ]);
  expect(
    detail.refunds.map((refund) => [
      refund.externalId,
      refund.transactions.map((payment) => payment.status),
    ]),
  ).toEqual([
    ['gid://shopify/Refund/2001', ['failed']],
    ['gid://shopify/Refund/2002', ['pending']],
  ]);
  expect(detail.refunds[0].lines[0]).toMatchObject({
    title: 'Canvas tote',
    restock: 'return',
  });
  expect(detail.order).toMatchObject({
    id: r.orders[1002],
    displayNumber: '#1002',
    externalId: 'gid://shopify/Order/1002',
    paymentStatus: 'paid',
  });
  expect(detail.timeline).toMatchObject({
    requestedAt: '2026-09-20T09:00:00Z',
    receivedAt: '2026-09-23T10:00:00Z',
  });
  expect(detail.related.map((item) => item.id)).toEqual([r.refunds.goodwill]);
  expect(detail.source).toMatchObject({
    label: 'Tokyo store',
    access: 'granted',
  });
  // A refund that settles a return opens that return.
  expect(
    (await f.request(f.member, `${f.base}/returns/${r.refunds.failedRefund}`))
      .item.id,
  ).toBe(r.returns.received);

  // The order lists its returns and refunds.
  const order = await f.request(f.member, `${f.base}/orders/${r.orders[1002]}`);
  expect(order.returns.map((item) => item.stage).sort()).toEqual([
    'refund_pending',
    'refunded',
  ]);
  expect(order.history.entries.map((entry) => entry.entityKind)).toEqual(
    expect.arrayContaining(['order', 'return', 'refund']),
  );

  // The pending payment later succeeds: money is returned and the return can be closed.
  await r.refund(
    '2002',
    1002,
    true,
    [{ status: 'success' }],
    '2026-09-25T10:00:00Z',
  );
  const settled = await f.request(
    f.member,
    `${f.base}/returns/${r.returns.received}`,
  );
  expect(settled.item).toMatchObject({
    stage: 'ready_to_close',
    group: 'action',
    refund: {
      state: 'refunded',
      refunded: '48',
      pending: null,
      failedAttempts: 1,
    },
  });

  // A reviewed request moves on; the earlier state stays as history.
  await r.returnRecord(
    1001,
    { requestedAt: '2026-09-25T09:00:00Z', approvedAt: '2026-09-26T09:00:00Z' },
    {},
    new Date(Date.now() + 1000).toISOString(),
  );
  const approved = await f.request(
    f.member,
    `${f.base}/returns/${r.returns.requested}`,
  );
  expect(approved.item.stage).toBe('awaiting_items');
  expect(
    approved.history.entries.map((entry) => [entry.status, entry.current]),
  ).toEqual([
    ['open', true],
    ['requested', false],
  ]);

  // A later read of an unchanged refund is kept as evidence without adding a list row.
  const before = await f.db.owner.query(
    "SELECT count(*)::int AS n FROM orders_snapshots WHERE tenant_id=$1 AND kind IN ('return','refund')",
    [f.org.id],
  );
  await r.refund(
    '2003',
    1002,
    false,
    [{ status: 'success', amount: { amount: '5.00', currency: 'EUR' } }],
    '2026-09-26T09:00:00Z',
  );
  const after = await f.db.owner.query(
    "SELECT count(*)::int AS n FROM orders_snapshots WHERE tenant_id=$1 AND kind IN ('return','refund')",
    [f.org.id],
  );
  expect(after.rows[0].n).toBe(before.rows[0].n + 1);
  expect(
    (await f.request(f.member, `${f.base}/returns?view=all`)).counts.views.all,
  ).toBe(4);
});

it('pages with a cursor bound to its filters and keeps other tenants out', async (t) => {
  const f = await settingsFixture(t);
  const r = await returnsFixture(t, f);
  const first = await f.request(f.member, `${f.base}/returns?view=all&limit=2`);
  expect(first.items).toHaveLength(2);
  const second = await f.request(
    f.member,
    `${f.base}/returns?view=all&limit=2&cursor=${first.nextCursor}`,
  );
  expect(second.items).toHaveLength(2);
  expect(second.nextCursor).toBeNull();
  expect(
    new Set([...first.items, ...second.items].map((item) => item.id)).size,
  ).toBe(4);
  await f.request(
    f.member,
    `${f.base}/returns?view=action&limit=2&cursor=${first.nextCursor}`,
    'GET',
    undefined,
    400,
  );
  await f.request(f.outsider, `${f.base}/returns`, 'GET', undefined, 404);
  await f.request(
    f.outsider,
    `${f.base}/returns/${r.returns.received}`,
    'GET',
    undefined,
    404,
  );
  await f.request(
    f.member,
    `${f.base}/returns/${randomUUID()}`,
    'GET',
    undefined,
    404,
  );
});

/** Encodes list conditions as the list API expects them. */
const conditions = (...items) =>
  `where=${encodeURIComponent(JSON.stringify({ match: 'all', conditions: items }))}`;

it('filters and groups returns by catalog conditions and finds them by their customer', async (t) => {
  const f = await settingsFixture(t);
  const r = await returnsFixture(t, f);
  // #1001 now reports one of two units received.
  await r.returnRecord(
    1001,
    { receivedAt: '2026-09-21T09:00:00Z' },
    { receivedQuantity: '1' },
    new Date().toISOString(),
  );
  const list = (query) => f.request(f.member, `${f.base}/returns?${query}`);
  const names = async (...items) =>
    (await list(conditions(...items))).items
      .map((item) => item.name ?? item.kind)
      .sort();

  expect(
    await names({ field: 'kind', op: 'any_of', value: ['refund'] }),
  ).toEqual(['refund']);
  expect(
    await names({
      field: 'refundState',
      op: 'any_of',
      value: ['pending', 'none'],
    }),
  ).toEqual(['#1001-R1', '#1002-R1']);
  expect(await names({ field: 'failedAttempts', op: 'gte', value: 1 })).toEqual(
    ['#1002-R1'],
  );
  expect(
    await names({ field: 'reasons', op: 'any_of', value: ['Defective'] }),
  ).toEqual(['#1002-R1']);
  // Amounts compare only within their currency.
  expect(
    await names({
      field: 'value',
      op: 'gte',
      value: { amount: '40', currency: 'EUR' },
    }),
  ).toEqual(['#1001-R1', '#1002-R1', '#1003-R1']);
  expect(
    await names({
      field: 'value',
      op: 'gte',
      value: { amount: '40', currency: 'USD' },
    }),
  ).toEqual([]);
  // A refund without a return reports no receipt: partial receipt is unknown for it.
  expect(
    await names({ field: 'partiallyReceived', op: 'is', value: true }),
  ).toEqual(['#1001-R1']);
  expect(
    await names({ field: 'partiallyReceived', op: 'is', value: false }),
  ).toEqual(['#1002-R1', '#1003-R1']);
  expect(await names({ field: 'partiallyReceived', op: 'unknown' })).toEqual([
    'refund',
  ]);
  expect(
    await names({
      field: 'stage',
      op: 'none_of',
      value: ['closed', 'refunded'],
    }),
  ).toEqual(['#1001-R1', '#1002-R1']);
  expect(
    await names({ field: 'source', op: 'any_of', value: [r.erp] }),
  ).toEqual([]);
  // Conditions narrow the counts too.
  expect(
    (await list(conditions({ field: 'kind', op: 'any_of', value: ['return'] })))
      .counts.views.all,
  ).toBe(3);

  // Stages group in lifecycle order with per-currency value sums.
  const byStage = await list('group=stage&groupLimit=1');
  expect(byStage.groups.map((group) => [group.key, group.count])).toEqual([
    ['awaiting_items', 1],
    ['refund_pending', 1],
    ['refunded', 1],
    ['closed', 1],
  ]);
  expect(byStage.groups[0].sums).toEqual([
    { field: 'value', currency: 'EUR', amount: '48.000000' },
  ]);
  const byReason = await list('group=reasons');
  expect(byReason.groups.map((group) => [group.key, group.count])).toEqual([
    ['Defective', 1],
    ['Size too small', 2],
    [null, 1],
  ]);
  const small = byReason.groups[1];
  const page = await list(
    `group=reasons&groupKey=${encodeURIComponent('"Size too small"')}&limit=1`,
  );
  expect(page.groups[0]).toMatchObject({ key: 'Size too small', count: 2 });
  const next = await list(
    `group=reasons&groupKey=${encodeURIComponent('"Size too small"')}&limit=1&cursor=${page.nextCursor}`,
  );
  expect([...page.items, ...next.items].map((item) => item.id).sort()).toEqual(
    [...small.itemIds].sort(),
  );
  await f.request(
    f.member,
    `${f.base}/returns?limit=1&cursor=${page.nextCursor}`,
    'GET',
    undefined,
    400,
  );
  for (const query of [
    conditions({ field: 'name', op: 'contains', value: '#1' }),
    conditions({ field: 'value', op: 'gt', value: 40 }),
    'group=value',
    'group=requested',
  ])
    await f.request(
      f.member,
      `${f.base}/returns?${query}`,
      'GET',
      undefined,
      400,
    );

  // Search finds returns by the order's customer, only for readers with customer access.
  const profile = randomUUID();
  await f.db.owner.query(
    `INSERT INTO customer_profiles(tenant_id,connection_id,external_id,id,display_name,email,phone,address,state,
      tags,contact_shared,address_shared,observed_at,observation_id)
     VALUES($1,$2,'gid://shopify/Customer/5',$3,'Mira Sato','mira@example.test',NULL,NULL,'enabled','{}',true,false,now(),$4)`,
    [f.org.id, r.store, profile, randomUUID()],
  );
  await f.db.owner.query(
    `INSERT INTO customer_orders(tenant_id,connection_id,order_scope_key,order_external_id,customer_external_id,observed_at)
     VALUES($1,$2,'','gid://shopify/Order/1002','gid://shopify/Customer/5',now())`,
    [f.org.id, r.store],
  );
  const search = async (q) =>
    (await list(`q=${encodeURIComponent(q)}`)).items
      .map((item) => item.name ?? item.kind)
      .sort();
  expect(await search('mira sato')).toEqual(['#1002-R1', 'refund']);
  expect(await search('MIRA@example')).toEqual(['#1002-R1', 'refund']);
  const created = await f.app.inject({
    method: 'POST',
    url: `${f.base}/roles`,
    headers: {
      origin: f.config.baseURL,
      cookie: f.owner.cookie,
      'x-command-id': randomUUID(),
    },
    payload: {
      name: 'Returns only',
      description: '',
      permissions: ['returns.read'],
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  await f.request(f.owner, `${f.base}/members/${f.membership.id}`, 'PATCH', {
    roleId: created.json().id,
  });
  expect(await search('mira')).toEqual([]);
});
