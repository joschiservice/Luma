import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

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

// Set LUMA_RETURN_BENCHMARK to a return count (for example 20000) to time return reads through
// the API at that size. Copies of one return spread across stages and request dates.
it.skipIf(!process.env.LUMA_RETURN_BENCHMARK)(
  'reads many returns within the request budget',
  { timeout: 600_000 },
  async (t) => {
    const count = Number(process.env.LUMA_RETURN_BENCHMARK);
    const f = await settingsFixture(t);
    const r = await returnsFixture(t, f);
    await f.db.owner.query(
      `WITH template AS (
        SELECT r.*,s.document,s.observation_id,s.mapping_version FROM orders_returns r
        JOIN orders_snapshots s ON s.tenant_id=r.tenant_id AND s.id=r.snapshot_id
        WHERE r.tenant_id=$1 AND r.entity_id=$2
      ), entities AS (
        INSERT INTO orders_entities(id,tenant_id,kind,reconciliation_key)
        SELECT gen_random_uuid(),$1,'return','bench-' || n FROM generate_series(1,$3::int) n
        RETURNING id,substr(reconciliation_key,7)::int AS n
      ), snapshots AS (
        INSERT INTO orders_snapshots(id,tenant_id,entity_id,kind,connection_id,observation_id,normalizer_version,
         mapping_version,source_updated_at,observed_at,document)
        SELECT gen_random_uuid(),$1,e.id,'return',t.connection_id,t.observation_id,'bench/1',t.mapping_version,
         NULL,now(),jsonb_set(t.document,'{entityId}',to_jsonb(e.id::text))
        FROM entities e CROSS JOIN template t RETURNING id,entity_id,connection_id
      ), projected AS (
        INSERT INTO orders_projections(tenant_id,entity_id,connection_id,snapshot_id)
        SELECT $1,entity_id,connection_id,id FROM snapshots RETURNING entity_id,snapshot_id
      )
      INSERT INTO orders_returns(tenant_id,entity_id,connection_id,snapshot_id,order_id,kind,name,order_number,status,
       stage,stage_group,refund_state,quantity,received,refunded_units,value_amount,value_currency,currency,
       refunded_amount,pending_amount,failed_attempts,reasons,requested_at,requested_key,activity_at,observed_at,
       source_updated_at,deleted)
      SELECT $1,p.entity_id,t.connection_id,p.snapshot_id,t.order_id,'return','#B' || e.n || '-R1','#B' || e.n,
       t.status,(ARRAY['requested','awaiting_items','awaiting_refund','refund_pending','closed','closed'])[1 + e.n % 6],
       (ARRAY['action','waiting','action','waiting','done','done'])[1 + e.n % 6],t.refund_state,t.quantity,
       t.received,t.refunded_units,t.value_amount,t.value_currency,t.currency,t.refunded_amount,t.pending_amount,
       t.failed_attempts,t.reasons,now() - e.n * interval '1 hour',now() - e.n * interval '1 hour',
       now() - e.n * interval '30 minutes',now(),NULL,false
      FROM projected p JOIN entities e ON e.id=p.entity_id CROSS JOIN template t`,
      [f.org.id, r.returns.received, count],
    );
    await f.db.owner.query('ANALYZE');
    const timings = {};
    const time = async (name, path) => {
      const runs = [];
      let body;
      for (let run = 0; run < 3; run++) {
        const start = performance.now();
        body = await f.request(f.member, `${f.base}/returns${path}`);
        runs.push(performance.now() - start);
      }
      timings[name] = Math.round(Math.min(...runs));

      return body;
    };
    const first = await time('needs action, oldest first', '?direction=asc');
    expect(first.counts.views.all).toBeGreaterThan(count);
    const all = await time('all, newest first', '?view=all');
    await time('stage filter', '?view=all&stage=refund_pending');
    await time('search by order number', '?view=all&q=%23B1234');
    await time('deep page', `?view=all&cursor=${all.nextCursor}`);
    await time('detail', `/${r.returns.received}`);
    await writeFile(
      `/tmp/luma103-returns-${count}.json`,
      JSON.stringify({ count, timings }, null, 2),
    );
  },
);
