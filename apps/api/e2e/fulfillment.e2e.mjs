import { randomUUID } from 'node:crypto';

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
