import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { fulfillmentFixture } from './fulfillment-fixture.mjs';
import { seedOperationalMetrics } from './operational-metrics-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

const hour = 3_600_000;

const ago = (hours) => new Date(Date.now() - hours * hour).toISOString();

/** Lists every record behind a chart point and series, following pages. */
async function records(f, chart, query, point, series, asOf) {
  const params = new URLSearchParams({ ...query, asOf, limit: '2' });
  if (point) params.set('point', point);
  if (series) params.set('series', series);
  const items = [];
  let offset = 0;
  let totalCount;
  do {
    params.set('offset', String(offset));
    const page = await f.request(
      f.member,
      `${f.base}/insights/${chart}/records?${params}`,
    );
    items.push(...page.items);
    totalCount = page.totalCount;
    offset = page.nextOffset;
  } while (offset !== null);

  return { totalCount, items };
}

/** Checks that every nonzero chart value equals its record list, and returns the records. */
async function reconcile(f, chart, query = {}) {
  const params = new URLSearchParams(query);
  const data = await f.request(
    f.member,
    `${f.base}/insights/${chart}?${params}`,
  );
  const found = [];
  for (const point of data.points)
    for (const series of data.series) {
      const value = point.values[series];
      const list = await records(f, chart, query, point.key, series, data.asOf);
      expect(list.totalCount, `${chart} ${point.key} ${series}`).toBe(value);
      expect(list.items).toHaveLength(value);
      found.push(...list.items.map((item) => ({ point, series, item })));
    }
  const all = await records(f, chart, query, undefined, undefined, data.asOf);
  expect(all.totalCount).toBe(data.total);

  return { data, found };
}

it('counts linked orders once, reconciles with the Orders list and states coverage', async (t) => {
  const f = await settingsFixture(t);
  const work = await fulfillmentFixture(t, f);
  const line = (external) => [{ external, quantity: '1' }];
  // The same order reported by the store and the ERP is one canonical order.
  for (const connectionId of [work.store, work.erp])
    await work.order({
      connectionId,
      external: connectionId === work.store ? 'order-400' : '400',
      key: 'order-400',
      updatedAt: ago(30),
      data: { displayNumber: '#400', placedAt: ago(30) },
      lines: line('line-400'),
    });
  await work.order({
    external: 'order-401',
    key: 'order-401',
    updatedAt: ago(20),
    data: { displayNumber: '#401', placedAt: ago(20), status: 'completed' },
    lines: line('line-401'),
  });
  await work.order({
    external: 'order-402',
    key: 'order-402',
    updatedAt: ago(5),
    data: { displayNumber: '#402', placedAt: ago(5), status: 'cancelled' },
    lines: line('line-402'),
  });
  await work.order({
    external: 'order-403',
    key: 'order-403',
    data: { displayNumber: '#403' },
    lines: line('line-403'),
  });
  await work.order({
    external: 'order-404',
    key: 'order-404',
    updatedAt: ago(24 * 40),
    data: { displayNumber: '#404', placedAt: ago(24 * 40) },
    lines: line('line-404'),
  });
  await work.order({
    external: 'order-405',
    key: 'order-405',
    updatedAt: ago(24 * 9),
    data: { displayNumber: '#405', placedAt: ago(24 * 9) },
    lines: line('line-405'),
  });

  const query = { range: '7d', timeZone: 'Europe/Berlin' };
  const { data, found } = await reconcile(f, 'orders', query);
  expect(data).toMatchObject({
    kind: 'timeline',
    unit: 'order',
    series: ['open', 'completed', 'cancelled', 'unknown'],
    window: { range: '7d', bucket: 'day', timeZone: 'Europe/Berlin' },
    sourceFilter: 'applied',
    dataThrough: null,
    coverage: {
      state: 'partial',
      excluded: [{ reason: 'no_placed_time', count: 1 }],
    },
  });
  expect(data.points).toHaveLength(7);
  // The previous stretch runs one range length earlier, up to the same point of its day, and
  // counts #405 with the same rules. Daylight saving can move it by an hour against UTC.
  const week = 7 * 24 * hour;
  expect(data.previous).toMatchObject({ total: 1, coverage: 'complete' });
  expect(
    Math.abs(
      Date.parse(data.window.from) - Date.parse(data.previous.from) - week,
    ),
  ).toBeLessThanOrEqual(hour);
  expect(
    Math.abs(Date.parse(data.asOf) - Date.parse(data.previous.before) - week),
  ).toBeLessThanOrEqual(hour);
  // Its records total the count, with the same rules as the chart.
  const before = await records(
    f,
    'orders',
    query,
    'previous',
    undefined,
    data.asOf,
  );
  expect(before.totalCount).toBe(data.previous.total);
  expect(before.items.map((item) => item.number)).toEqual(['#405']);
  expect(data.coverage.sources.map((s) => [s.label, s.state])).toEqual([
    ['JTL-Wawi', 'not_synced'],
    ['Tokyo store', 'not_synced'],
  ]);
  const numbers = found.map(({ item }) => item.number).sort();
  // #400 counts once; #403 has no placed time; #404 and #405 are outside the window.
  expect(numbers).toEqual([
    '#200',
    '#201',
    '#202',
    '#203',
    '#300',
    '#400',
    '#401',
    '#402',
  ]);
  expect(
    found
      .filter(({ series }) => series !== 'open')
      .map(({ series, item }) => [item.number, series]),
  ).toEqual(
    expect.arrayContaining([
      ['#401', 'completed'],
      ['#402', 'cancelled'],
    ]),
  );
  const linked = found.find(({ item }) => item.number === '#400').item;
  expect(linked.sources.map((s) => s.label).sort()).toEqual([
    'JTL-Wawi',
    'Tokyo store',
  ]);

  // Every point matches the Orders list's placed and status filters exactly.
  for (const point of data.points)
    for (const series of data.series) {
      const list = await f.request(
        f.member,
        `${f.base}/orders?${new URLSearchParams({
          count: 'exact',
          status: series,
          placedFrom: point.from,
          placedBefore: point.before,
          limit: '1',
        })}`,
      );
      expect(list.totalCount, `${point.key} ${series}`).toBe(
        point.values[series],
      );
    }

  // A source filter counts that source's own records, so a linked order counts in each.
  const store = await reconcile(f, 'orders', {
    ...query,
    connectionId: work.store,
  });
  const erp = await reconcile(f, 'orders', {
    ...query,
    connectionId: work.erp,
  });
  expect(store.data.total + erp.data.total).toBe(data.total + 1);
  expect(erp.data.coverage.sources.map((s) => s.label)).toEqual(['JTL-Wawi']);

  // Imported history marks earlier buckets as unknown and bounds the data-through time.
  const historyFrom = data.points[3].from;
  // Near midnight, an hour ago belongs to yesterday; keep this fixture's watermark in the latest bucket.
  const watermark = new Date(
    Math.max(Date.now() - hour, Date.parse(data.points.at(-1).from)),
  ).toISOString();
  for (const connectionId of [work.store, work.erp])
    await f.db.owner.query(
      `INSERT INTO commerce_sync_streams(tenant_id,id,connection_id,record_type,principal_id,phase,
        watermark,history_from,last_success_at)
       VALUES($1,$2,$3,'orders',$4,'incremental',$5,$6,$5)`,
      [
        f.org.id,
        randomUUID(),
        connectionId,
        f.owner.id,
        watermark,
        historyFrom,
      ],
    );
  const synced = await f.request(
    f.member,
    `${f.base}/insights/orders?${new URLSearchParams(query)}`,
  );
  expect(synced.coverage.state).toBe('partial');
  expect(new Set(synced.coverage.sources.map((s) => s.state))).toEqual(
    new Set(['limited']),
  );
  expect(synced.dataThrough).toBe(watermark);
  expect(synced.points.map((p) => p.coverage)).toEqual([
    'not_imported',
    'not_imported',
    'not_imported',
    'complete',
    'complete',
    'complete',
    'partial',
  ]);
  // Before the imported history, the previous stretch is unknown rather than zero.
  expect(synced.previous.coverage).toBe('not_imported');
  const weekly = await f.request(
    f.member,
    `${f.base}/insights/orders?range=13w&timeZone=UTC`,
  );
  expect(weekly.window.bucket).toBe('week');
  expect(weekly.points).toHaveLength(13);
  expect(new Date(`${weekly.points[0].start}T00:00:00Z`).getUTCDay()).toBe(1);

  await f.request(
    f.member,
    `${f.base}/insights/orders?timeZone=Mars%2FOlympus`,
    'GET',
    undefined,
    400,
  );
  await f.request(
    f.member,
    `${f.base}/insights/orders/records?asOf=${ago(1)}`,
    'GET',
    undefined,
    400,
  );
  await f.request(
    f.member,
    `/v1/organizations/${randomUUID()}/insights/orders`,
    'GET',
    undefined,
    404,
  );
});

it('breaks open fulfillment work down by waiting time and its first signal', async (t) => {
  const f = await settingsFixture(t);
  await fulfillmentFixture(t, f);
  const list = await f.request(f.member, `${f.base}/fulfillment?view=open`);
  const { data, found } = await reconcile(f, 'fulfillment');
  expect(data).toMatchObject({
    kind: 'breakdown',
    unit: 'fulfillment',
    window: null,
    previous: null,
    series: ['held', 'overdue', 'stalled', 'none'],
    total: list.counts.open,
  });
  expect(data.points.map((p) => p.key)).toEqual([
    'under_1d',
    '1_2d',
    '2_7d',
    'over_7d',
  ]);
  expect(
    found
      .map(({ point, series, item }) => [item.order.number, point.key, series])
      .sort(),
  ).toEqual([
    ['#200', expect.any(String), 'held'],
    ['#201', '2_7d', 'stalled'],
    ['#300', 'under_1d', 'none'],
  ]);
  expect(
    found.find(({ item }) => item.order.number === '#200').item,
  ).toMatchObject({
    signals: ['held', 'overdue'],
    source: { label: 'Tokyo store' },
  });
});

it('charts issues, stock risk and purchase-order stages from their owners', async (t) => {
  const f = await settingsFixture(t);
  const seeded = await seedOperationalMetrics(f, 2);
  const { order } = await seeded.createOrder('SKU-0');

  const cases = await reconcile(f, 'cases', { range: '7d' });
  expect(cases.data).toMatchObject({
    unit: 'case',
    total: 2,
    sourceFilter: 'not_applicable',
    coverage: { state: 'complete' },
    // Luma detected nothing before these issues, so the previous week is unknown, not empty.
    previous: { total: 0, coverage: 'not_imported' },
  });
  expect(cases.data.points.at(-1).values.workflow_failure).toBe(2);
  expect(cases.found.map(({ item }) => item.attention)).toEqual([
    'uncertainty',
    'uncertainty',
  ]);

  const stock = await reconcile(f, 'stock');
  expect(
    Object.fromEntries(stock.data.points.map((p) => [p.key, p.total])),
  ).toEqual({
    below_no_order: 1,
    below_with_order: 1,
    unknown: 0,
    at_or_above: 0,
  });
  expect(stock.data.coverage.state).toBe('complete');
  expect(
    stock.found.find(({ point }) => point.key === 'below_with_order').item,
  ).toMatchObject({
    sku: 'SKU-0',
    available: 5,
    minimum: 10,
    purchaseOrderIds: [order.id],
    source: { label: 'Warehouse' },
  });
  const other = await f.request(
    f.member,
    `${f.base}/insights/stock?connectionId=${randomUUID()}`,
  );
  expect(other).toMatchObject({ total: 0, coverage: { state: 'unavailable' } });

  const procurement = await reconcile(f, 'procurement');
  expect(procurement.data.total).toBe(1);
  expect(
    procurement.found.map(({ point, series, item }) => [
      point.key,
      series,
      item.reference,
    ]),
  ).toEqual([['draft', 'not_overdue', 'PO-SKU-0']]);
});
