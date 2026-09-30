import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import { expect, it } from 'vitest';

import { fulfillmentFixture } from './fulfillment-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

it('classifies held, delayed and in-transit fulfillments and explains one with its evidence', async (t) => {
  const f = await settingsFixture(t);
  const work = await fulfillmentFixture(t, f);
  const list = await f.request(f.member, `${f.base}/fulfillment`);
  expect(list.counts).toEqual({
    attention: 3,
    held: 1,
    delayed: 3,
    open: 3,
    in_transit: 1,
    all: 6,
  });
  expect(list.stalledAfterHours).toBe(48);
  // Attention is ordered by the longest wait for progress first.
  expect(list.items.map((item) => [item.order.number, item.signals])).toEqual([
    ['#201', ['stalled']],
    ['#200', ['held', 'overdue']],
    ['#202', ['delivery_issue']],
  ]);
  const held = list.items[1];
  expect(held).toMatchObject({
    id: work.ids.held,
    externalId: 'gid://shopify/FulfillmentOrder/200',
    kind: 'fulfillment_order',
    status: 'pending',
    open: true,
    holds: ['incorrect_address'],
    location: { id: expect.any(String), name: 'Tokyo warehouse' },
    method: { type: 'shipping', name: 'Express' },
    units: '2',
    unit: 'each',
  });
  expect(list.sources.map((source) => source.label)).toEqual([
    'JTL-Wawi',
    'Tokyo store',
  ]);
  expect(list.locations).toEqual([
    { id: held.location.id, name: 'Tokyo warehouse', open: 2 },
  ]);

  const view = async (query) =>
    (await f.request(f.member, `${f.base}/fulfillment?${query}`)).items.map(
      (item) => item.order.number,
    );
  expect(await view('view=held')).toEqual(['#200']);
  expect(await view('view=in_transit')).toEqual(['#202']);
  expect(await view('view=open&sort=recent')).toEqual(['#300', '#200', '#201']);
  // Dated work first by fulfill-by or estimated delivery, then the rest by waiting time.
  expect(await view('view=all&sort=deadline')).toEqual([
    '#202',
    '#200',
    '#202',
    '#201',
    '#203',
    '#300',
  ]);
  expect(await view(`view=all&connectionId=${work.erp}`)).toEqual(['#300']);
  expect(await view('view=all&kind=shipment&sort=recent')).toEqual([
    '#300',
    '#202',
    '#203',
  ]);
  expect(await view(`view=open&locationId=${held.location.id}`)).toEqual([
    '#201',
    '#200',
  ]);
  for (const [q, expected] of [
    ['4521-8876', ['#202']],
    ['#203', ['#203']],
    ['tokyo WARE', ['#201', '#202', '#200', '#202']],
    ['gid://shopify/FulfillmentOrder/201', ['#201']],
    ['order-200', ['#200']],
  ])
    expect(await view(`view=all&q=${encodeURIComponent(q)}`)).toEqual(expected);

  // Pages keep the evaluation time and filters of the first page.
  const first = await f.request(f.member, `${f.base}/fulfillment?limit=2`);
  expect(first.items).toHaveLength(2);
  const second = await f.request(
    f.member,
    `${f.base}/fulfillment?limit=2&cursor=${first.nextCursor}`,
  );
  expect(second.asOf).toBe(first.asOf);
  expect(second.items.map((item) => item.order.number)).toEqual(['#202']);
  expect(second.nextCursor).toBeNull();
  await f.request(
    f.member,
    `${f.base}/fulfillment?view=held&cursor=${first.nextCursor}`,
    'GET',
    undefined,
    400,
  );

  const issueId = await work.issue();
  const detail = await f.request(
    f.member,
    `${f.base}/fulfillment/${work.ids.held}`,
  );
  expect(detail.item.signals).toEqual(['held', 'overdue']);
  expect(detail.source).toMatchObject({
    connectionId: work.store,
    label: 'Tokyo store',
    system: 'shopify',
  });
  expect(detail.lines).toEqual([
    {
      orderLineId: expect.any(String),
      quantity: '2',
      unit: 'each',
      skuId: expect.any(String),
      skuCode: null,
      title: null,
      ordered: '2',
    },
  ]);
  expect(detail.order).toMatchObject({
    number: '#200',
    status: 'open',
    paymentStatus: 'paid',
    externalId: 'order-200',
    fulfillment: 'unfulfilled',
  });
  expect(detail.related).toEqual([]);
  expect(
    detail.timeline.entries.map((entry) => [entry.holds, entry.current]),
  ).toEqual([
    [['incorrect_address'], true],
    [[], false],
  ]);
  expect(detail.issues).toMatchObject([
    { id: issueId, class: 'stuck_fulfillment', relationship: 'fulfillment' },
  ]);
  expect(detail.workflows).toEqual([]);

  const shipment = await f.request(
    f.member,
    `${f.base}/fulfillment/${work.ids.attempted}`,
  );
  expect(shipment.item).toMatchObject({
    kind: 'shipment',
    delivery: 'attempted_delivery',
    tracking: [{ carrier: 'Yamato', number: '4521-8876-0012' }],
  });
  expect(shipment.related.map((item) => [item.kind, item.status])).toEqual([
    ['fulfillment_order', 'completed'],
  ]);
  expect(shipment.order.fulfillment).toBe('fulfilled');

  // A tombstone leaves the work visible as removed, never as open.
  await work.fulfillment({
    external: 'gid://shopify/FulfillmentOrder/201',
    order: 'order-201',
    lines: [{ external: 'line-201', quantity: '2' }],
    status: 'processing',
    deleted: true,
  });
  const removed = await f.request(
    f.member,
    `${f.base}/fulfillment/${work.ids.stalled}`,
  );
  expect(removed.item).toMatchObject({
    deleted: true,
    open: false,
    signals: [],
  });

  await f.request(f.outsider, `${f.base}/fulfillment`, 'GET', undefined, 404);
  await f.request(
    f.outsider,
    `${f.base}/fulfillment/${work.ids.held}`,
    'GET',
    undefined,
    404,
  );
  await f.request(
    f.member,
    `${f.base}/fulfillment/${randomUUID()}`,
    'GET',
    undefined,
    404,
  );
});

// Set LUMA_FULFILLMENT_BENCHMARK to a fulfillment count (for example 100000) to time list and
// detail reads through the API at that size. Copies spread across open, held, shipped and
// completed states, with a tenth past their fulfill-by date.
it.skipIf(!process.env.LUMA_FULFILLMENT_BENCHMARK)(
  'reads a large fulfillment list within the request budget',
  { timeout: 600_000 },
  async (t) => {
    const count = Number(process.env.LUMA_FULFILLMENT_BENCHMARK);
    const f = await settingsFixture(t);
    const work = await fulfillmentFixture(t, f);
    await f.db.owner.query(
      `WITH template AS (
        SELECT l.*,s.document,s.observation_id,s.normalizer_version,s.mapping_version
        FROM orders_fulfillment_list l JOIN orders_snapshots s ON s.tenant_id=l.tenant_id AND s.id=l.snapshot_id
        WHERE l.tenant_id=$1 AND l.entity_id=$2
      ), entities AS (
        INSERT INTO orders_entities(id,tenant_id,kind,reconciliation_key)
        SELECT gen_random_uuid(),$1,'fulfillment','bench-'||n FROM generate_series(1,$3::int) n
        RETURNING id,substr(reconciliation_key,7)::int AS n
      ), snapshots AS (
        INSERT INTO orders_snapshots(id,tenant_id,entity_id,kind,connection_id,observation_id,normalizer_version,
         mapping_version,source_updated_at,observed_at,document)
        SELECT gen_random_uuid(),$1,e.id,'fulfillment',t.connection_id,t.observation_id,t.normalizer_version,
         t.mapping_version,t.source_updated_at,t.observed_at,jsonb_set(t.document,'{entityId}',to_jsonb(e.id::text))
        FROM entities e CROSS JOIN template t RETURNING id,entity_id
      ), projected AS (
        INSERT INTO orders_projections(tenant_id,entity_id,connection_id,snapshot_id)
        SELECT $1,s.entity_id,t.connection_id,s.id FROM snapshots s CROSS JOIN template t RETURNING entity_id,snapshot_id
      )
      INSERT INTO orders_fulfillment_list(tenant_id,entity_id,connection_id,snapshot_id,order_id,kind,status,deleted,
       hold_reasons,location_id,location_name,method_type,method_name,fulfill_at,fulfill_by,estimated_delivery_at,
       last_progress_at,delivery,failure_code,tracking_numbers,units,unit,order_number,order_status,order_placed_at,
       observed_at,source_updated_at,open,progress_at,deadline_at)
      SELECT $1,p.entity_id,t.connection_id,p.snapshot_id,t.order_id,
       CASE WHEN e.n%4=2 THEN 'shipment' ELSE 'fulfillment_order' END,
       (ARRAY['pending','processing','shipped','completed'])[e.n%4+1],false,
       CASE WHEN e.n%25=0 THEN ARRAY['incorrect_address'] ELSE '{}'::text[] END,
       t.location_id,t.location_name,t.method_type,t.method_name,NULL,
       now()+CASE WHEN e.n%10=0 THEN interval '-1 day' ELSE interval '2 days' END,NULL,
       now()-(e.n%5000)*interval '1 minute',NULL,NULL,ARRAY['TRACK-'||e.n],2,'each','#B'||e.n,'open',now(),
       now(),now(),e.n%4<2,now()-(e.n%5000)*interval '1 minute',
       now()+CASE WHEN e.n%10=0 THEN interval '-1 day' ELSE interval '2 days' END
      FROM projected p JOIN entities e ON e.id=p.entity_id CROSS JOIN template t`,
      [f.org.id, work.ids.held, count],
    );
    await f.db.owner.query('ANALYZE');
    const timings = {};
    const time = async (name, path) => {
      const runs = [];
      let body;
      for (let run = 0; run < 3; run++) {
        const start = performance.now();
        body = await f.request(f.member, `${f.base}/fulfillment${path}`);
        runs.push(performance.now() - start);
      }
      timings[name] = Math.round(Math.min(...runs));

      return body;
    };
    const first = await time('attention', '');
    expect(first.counts.all).toBeGreaterThan(count);
    await time('held view', '?view=held');
    await time('all by deadline', '?view=all&sort=deadline');
    await time('selective search', '?view=all&q=TRACK-12345');
    const second = await time('second page', `?cursor=${first.nextCursor}`);
    await time('deep page', `?cursor=${second.nextCursor}`);
    await time('detail', `/${work.ids.held}`);
    await writeFile(
      `/tmp/luma102-fulfillment-${count}.json`,
      JSON.stringify({ count, timings }, null, 2),
    );
  },
);
