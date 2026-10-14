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
  // Every sort runs in both directions; work without a value stays last.
  expect(await view('view=open&sort=waiting&direction=desc')).toEqual([
    '#300',
    '#200',
    '#201',
  ]);
  expect(await view('view=all&sort=deadline&direction=desc')).toEqual([
    '#202',
    '#200',
    '#202',
    '#300',
    '#203',
    '#201',
  ]);
  expect(await view('view=all&sort=orderNumber')).toEqual([
    '#200',
    '#201',
    '#202',
    '#202',
    '#203',
    '#300',
  ]);
  const fulfillBy = (
    await f.request(
      f.member,
      `${f.base}/fulfillment?view=all&sort=fulfillBy&direction=desc`,
    )
  ).items.map((item) => item.fulfillBy);
  const dated = fulfillBy.filter((value) => value !== null);
  expect(dated).toEqual([...dated].sort().reverse());
  expect(fulfillBy.slice(dated.length).every((value) => value === null)).toBe(
    true,
  );
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

/** Encodes list conditions as the list API expects them. */
const conditions = (...items) =>
  `where=${encodeURIComponent(JSON.stringify({ match: 'all', conditions: items }))}`;

it('filters and groups fulfillments by catalog conditions, keeping unreported facts unknown', async (t) => {
  const f = await settingsFixture(t);
  const work = await fulfillmentFixture(t, f);
  // Two more shipments of #203 with reported handoff stages.
  await work.fulfillment({
    external: 'gid://shopify/Fulfillment/2031',
    order: 'order-203',
    lines: [{ external: 'line-203', quantity: '1' }],
    status: 'shipped',
    facts: {
      kind: 'shipment',
      tracking: [{ carrier: 'DHL', number: 'DHL-77', url: null }],
      shipping: { stage: 'carrier', sourceUrl: null, trackingUpdatedAt: null },
    },
  });
  await work.fulfillment({
    external: 'gid://shopify/Fulfillment/2032',
    order: 'order-203',
    lines: [{ external: 'line-203', quantity: '1' }],
    status: 'pending',
    facts: {
      kind: 'shipment',
      tracking: [],
      shipping: { stage: 'merchant', sourceUrl: null, trackingUpdatedAt: null },
    },
  });
  const list = (query) =>
    f.request(f.member, `${f.base}/fulfillment?view=all&${query}`);
  const numbers = async (...items) =>
    (await list(conditions(...items))).items
      .map((item) => item.order.number)
      .sort();
  const location = (await list('')).locations[0].id;

  expect(
    await numbers({
      field: 'status',
      op: 'any_of',
      value: ['shipped', 'delivered'],
    }),
  ).toEqual(['#202', '#203', '#203']);
  expect(
    await numbers({
      field: 'signals',
      op: 'any_of',
      value: ['stalled', 'held'],
    }),
  ).toEqual(['#200', '#201']);
  // Holds a source does not report are unknown: they match neither a reason nor empty.
  expect(
    await numbers({
      field: 'holds',
      op: 'any_of',
      value: ['incorrect_address'],
    }),
  ).toEqual(['#200']);
  expect(await numbers({ field: 'holds', op: 'empty' })).toEqual([
    '#201',
    '#202',
  ]);
  expect(await numbers({ field: 'holds', op: 'unknown' })).toEqual([
    '#202',
    '#203',
    '#203',
    '#203',
    '#300',
  ]);
  expect(await numbers({ field: 'carrier', op: 'is', value: 'dhl' })).toEqual([
    '#203',
  ]);
  expect(
    await numbers({ field: 'carrier', op: 'contains', value: 'yam' }),
  ).toEqual(['#202']);
  expect(
    await numbers({ field: 'hasTracking', op: 'is', value: true }),
  ).toEqual(['#202', '#203']);
  expect(
    await numbers({
      field: 'stage',
      op: 'any_of',
      value: ['merchant', 'carrier'],
    }),
  ).toEqual(['#203', '#203']);
  expect(
    await numbers({
      field: 'delivery',
      op: 'any_of',
      value: ['attempted_delivery'],
    }),
  ).toEqual(['#202']);
  expect(
    await numbers(
      { field: 'location', op: 'any_of', value: [location] },
      { field: 'methodType', op: 'any_of', value: ['shipping'] },
    ),
  ).toEqual(['#200', '#201', '#202']);
  expect(
    await numbers({
      field: 'fulfillBy',
      op: 'before',
      value: new Date().toISOString(),
    }),
  ).toEqual(['#200', '#202']);
  // Conditions narrow the per-view counts too.
  const shipments = await list(
    conditions({ field: 'kind', op: 'any_of', value: ['shipment'] }),
  );
  expect(shipments.counts).toMatchObject({ all: 5, in_transit: 2 });

  // The shipping board groups in handoff order; work without a stage comes last.
  const byStage = await list('group=stage');
  expect(byStage.groups.map((group) => [group.key, group.count])).toEqual([
    ['merchant', 1],
    ['carrier', 1],
    [null, 6],
  ]);
  expect(
    (await list('group=signals')).groups.map((group) => [
      group.key,
      group.count,
    ]),
  ).toEqual([
    ['held', 1],
    ['overdue', 1],
    ['stalled', 1],
    ['delivery_issue', 1],
    [null, 5],
  ]);
  expect(
    (await list('group=carrier')).groups.map((group) => [
      group.key,
      group.count,
    ]),
  ).toEqual([
    ['DHL', 1],
    ['Yamato', 1],
    [null, 6],
  ]);
  const byStatus = await f.request(
    f.member,
    `${f.base}/fulfillment?view=open&group=status&groupLimit=1`,
  );
  expect(byStatus.groups.map((group) => [group.key, group.count])).toEqual([
    ['pending', 2],
    ['processing', 2],
  ]);
  expect(byStatus.items).toHaveLength(2);
  // A group's page link continues within it at the first page's evaluation time.
  const pending = byStatus.groups[0];
  const rest = await f.request(
    f.member,
    `${f.base}/fulfillment?view=open&group=status&groupKey=${encodeURIComponent('"pending"')}&cursor=${pending.nextCursor}`,
  );
  expect(rest.asOf).toBe(byStatus.asOf);
  expect(rest.items).toHaveLength(1);
  expect(rest.items[0].id).not.toBe(pending.itemIds[0]);
  expect(rest.groups[0]).toMatchObject({ key: 'pending', count: 2 });
  await f.request(
    f.member,
    `${f.base}/fulfillment?view=open&cursor=${pending.nextCursor}`,
    'GET',
    undefined,
    400,
  );
  expect((await list('group=fulfillBy:week')).groups.at(-1)).toMatchObject({
    key: null,
    count: 6,
  });

  for (const query of [
    conditions({ field: 'order', op: 'contains', value: '#2' }),
    conditions({ field: 'status', op: 'any_of', value: ['lost'] }),
    'group=fulfillBy',
    'group=units',
    'timeZone=Mars%2FOlympus',
  ])
    await f.request(
      f.member,
      `${f.base}/fulfillment?${query}`,
      'GET',
      undefined,
      400,
    );
  await f.request(
    f.outsider,
    `${f.base}/fulfillment?group=status`,
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
       observed_at,source_updated_at,open,progress_at,deadline_at,carriers,shipping_stage)
      SELECT $1,p.entity_id,t.connection_id,p.snapshot_id,t.order_id,
       CASE WHEN e.n%4=2 THEN 'shipment' ELSE 'fulfillment_order' END,
       (ARRAY['pending','processing','shipped','completed'])[e.n%4+1],false,
       CASE WHEN e.n%25=0 THEN ARRAY['incorrect_address'] ELSE '{}'::text[] END,
       t.location_id,t.location_name,t.method_type,t.method_name,NULL,
       now()+CASE WHEN e.n%10=0 THEN interval '-1 day' ELSE interval '2 days' END,NULL,
       now()-(e.n%5000)*interval '1 minute',NULL,NULL,ARRAY['TRACK-'||e.n],2,'each','#B'||e.n,'open',now(),
       now(),now(),e.n%4<2,now()-(e.n%5000)*interval '1 minute',
       now()+CASE WHEN e.n%10=0 THEN interval '-1 day' ELSE interval '2 days' END,
       CASE WHEN e.n%4=2 THEN ARRAY[(ARRAY['DHL','UPS','Yamato'])[e.n%3+1]] ELSE '{}'::text[] END,
       CASE WHEN e.n%4=2 THEN (ARRAY['merchant','warehouse','carrier','delivered','unknown'])[e.n%5+1] END
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
    const where = (...conditions) =>
      `where=${encodeURIComponent(JSON.stringify({ match: 'all', conditions }))}`;
    await time(
      'carrier and stage conditions',
      `?view=all&${where(
        { field: 'carrier', op: 'is', value: 'dhl' },
        { field: 'stage', op: 'any_of', value: ['carrier', 'warehouse'] },
      )}`,
    );
    await time(
      'signal condition',
      `?view=all&${where({ field: 'signals', op: 'any_of', value: ['overdue'] })}`,
    );
    await time('stage board', '?view=all&group=stage');
    await time('signal groups', '?view=all&group=signals');
    await time('fulfill-by weeks', '?view=all&group=fulfillBy:week');
    const board = await time(
      'carrier groups',
      '?view=all&group=carrier&groupLimit=25',
    );
    const group = board.groups.find((item) => item.nextCursor);
    await time(
      'page within a group',
      `?view=all&group=carrier&groupKey=${encodeURIComponent(JSON.stringify(group.key))}&cursor=${group.nextCursor}`,
    );
    await writeFile(
      `/tmp/luma102-fulfillment-${count}.json`,
      JSON.stringify({ count, timings }, null, 2),
    );
  },
);
