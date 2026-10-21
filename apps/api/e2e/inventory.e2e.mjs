import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { inventoryFixture } from './inventory-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

it('reads recorded detection limits with the restricted case reader and rejects another workspace', async (t) => {
  const f = await settingsFixture(t);
  const stock = await inventoryFixture(t, f);
  const issueId = await stock.issue();
  const issue = await f.request(f.member, `${f.base}/exceptions/${issueId}`);
  expect(issue.subject.label).toBe('SKU-100');
  expect(issue.detectionLimits).toMatchObject({
    inventoryTolerance: '0',
    oversellPropagationSeconds: 120,
  });
  await f.request(
    f.outsider,
    `${f.base}/exceptions/${issueId}`,
    'GET',
    undefined,
    404,
  );
});

it('compares mapped stock without summing sources and follows scoped related records', async (t) => {
  const f = await settingsFixture(t);
  const stock = await inventoryFixture(t, f);
  const { position } = stock;
  expect(position.differences).toEqual(['available']);
  expect(position.sources.map((s) => s.available).sort()).toEqual(['12', '9']);
  expect(position.sources.every((s) => s.incoming === null)).toBe(true);
  await stock.stock({
    onHand: '3',
    reserved: '1',
    amount: '-2',
    states: {
      committed: '5',
      incoming: '7',
      damaged: '0',
      qualityControl: '2',
      safetyStock: '3',
      locationActive: true,
      itemActive: false,
      tracked: true,
      inventorySemantics: 'shopify/1',
    },
  });
  const stateDetail = await f.request(
    f.member,
    `${f.base}/inventory/${position.id}`,
  );
  const stateSource = stateDetail.position.sources.find(
    (source) => source.connectionId === stock.store,
  );
  expect(stateSource).toMatchObject({
    committed: '5',
    reserved: '1',
    available: '-2',
    incoming: '7',
    damaged: '0',
    qualityControl: '2',
    safetyStock: '3',
    locationActive: true,
    itemActive: false,
  });
  expect(stateDetail.position.differences).toEqual(['onHand', 'available']);
  expect(
    stateDetail.history.entries.find(
      (entry) => entry.connectionId === stock.store && entry.current,
    ),
  ).toMatchObject({
    committed: '5',
    reserved: '1',
    incoming: '7',
    itemActive: false,
  });
  await f.request(
    f.outsider,
    `${f.base}/inventory/${position.id}`,
    'GET',
    undefined,
    404,
  );
  const searched = await f.request(
    f.member,
    `${f.base}/inventory?q=77&connectionId=${stock.erp}`,
  );
  expect(searched.items).toHaveLength(1);
  expect(searched.items[0].sources).toHaveLength(2);
  expect(
    (await f.request(f.member, `${f.base}/inventory?q=Tokyo`)).items,
  ).toHaveLength(1);
  expect(
    (await f.request(f.member, `${f.base}/inventory?q=%25`)).items,
  ).toHaveLength(0);
  const supplierId = randomUUID(),
    poId = randomUUID();
  await f.request(
    f.owner,
    `${f.base}/procurement/suppliers`,
    'POST',
    { id: supplierId, name: 'Supplier', externalReferences: [] },
    200,
  );
  await f.request(
    f.owner,
    `${f.base}/procurement/purchase-orders`,
    'POST',
    {
      id: poId,
      supplierId,
      reference: 'PO-100',
      authority: 'luma',
      externalReferences: [],
      origin: {},
      lines: [
        {
          id: randomUUID(),
          sku: 'SKU-100',
          description: 'Stock',
          quantity: 20,
          unit: 'each',
        },
      ],
    },
    200,
  );
  const issueId = randomUUID();
  for (const [id, scope] of [
    [issueId, stock.erp],
    [randomUUID(), randomUUID()],
  ]) {
    const fingerprint = id.replaceAll('-', '').padEnd(64, '0');
    await f.db.owner.query(
      'INSERT INTO exceptions(id,tenant_id,fingerprint,state,document) VALUES($1,$2,$3,$4,$5)',
      [
        id,
        f.org.id,
        fingerprint,
        'detected',
        {
          id,
          tenantId: f.org.id,
          fingerprint,
          state: 'detected',
          occurrenceCount: 1,
          exceptionClass: 'inventory_mismatch',
          severity: 'high',
          summary: 'Stock differs for SKU-100',
          subject: { subjectKind: 'sku', subjectId: '77', scope: [scope] },
        },
      ],
    );
  }
  const detail = await f.request(
    f.member,
    `${f.base}/inventory/${position.id}`,
  );
  expect(detail.issues.map((issue) => issue.id)).toEqual([issueId]);
  expect(detail.orders[0].id).toBe(stock.orderId);
  expect(detail.purchaseOrders[0].id).toBe(poId);
  expect(detail.history.entries).toHaveLength(4);
  expect(detail.history.entries.filter((e) => e.current)).toHaveLength(2);
  await stock.stock({ location: 'Osaka', amount: null });
  const all = await f.request(
    f.member,
    `${f.base}/inventory?skuId=${stock.skuId}`,
  );
  expect(all.items).toHaveLength(2);
  expect(
    (await f.request(f.member, `${f.base}/inventory?view=differs`)).items,
  ).toHaveLength(1);
  expect(
    (await f.request(f.member, `${f.base}/inventory?view=unknown`)).items,
  ).toHaveLength(1);
  await stock.stock({ unit: 'box', amount: '3' });
  const withUnit = await f.request(
    f.member,
    `${f.base}/inventory?skuId=${stock.skuId}`,
  );
  expect(withUnit.items).toHaveLength(3);
  expect(
    withUnit.items.find((item) => item.unit === 'box').differences,
  ).toEqual([]);
  await stock.stock({
    deleted: true,
    time: new Date(Date.now() + 1000).toISOString(),
  });
  expect(
    (await f.request(f.member, `${f.base}/inventory?view=differs`)).items,
  ).toHaveLength(0);
  await f.request(f.outsider, `${f.base}/inventory`, 'GET', undefined, 404);
  await f.request(
    f.outsider,
    `${f.base}/inventory/${position.id}`,
    'GET',
    undefined,
    404,
  );
  await f.request(
    f.member,
    `${f.base}/inventory/${randomUUID()}`,
    'GET',
    undefined,
    404,
  );
  await f.request(
    f.member,
    `${f.base}/inventory?cursor=broken`,
    'GET',
    undefined,
    400,
  );
  await f.request(null, `${f.base}/inventory`, 'GET', undefined, 401);
});

it('pages positions without duplicates and rejects a cursor for different filters', async (t) => {
  const f = await settingsFixture(t);
  const stock = await inventoryFixture(t, f);
  for (let i = 0; i < 51; i++) {
    await stock.stock({ sku: `SKU-${i + 200}`, external: `SKU-${i + 200}` });
    if (i % 3 === 0)
      await stock.stock({
        connectionId: stock.erp,
        sku: `SKU-${i + 200}`,
        external: `erp-${i + 200}`,
        amount: '9',
      });
  }
  const first = await f.request(f.member, `${f.base}/inventory`);
  expect(first.items).toHaveLength(50);
  expect(first.nextCursor).toBeTruthy();
  const next = await f.request(
    f.member,
    `${f.base}/inventory?cursor=${first.nextCursor}`,
  );
  expect(next.items).toHaveLength(2);
  expect(next.nextCursor).toBeNull();
  expect(new Set([...first.items, ...next.items].map((i) => i.id)).size).toBe(
    52,
  );
  const positions = [...first.items, ...next.items];
  // The default order is SKU, then location.
  const labels = positions.map((item) => `${item.sku}\u0000${item.location}`);
  expect(labels).toEqual(
    [...labels].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  // Quantity sorts use the lowest value any source reports; positions without one come last.
  const lowest = (item) => {
    const values = item.sources
      .map((source) => source.available)
      .filter((value) => value !== null)
      .map(Number);

    return values.length ? Math.min(...values) : null;
  };
  const byAvailable = [];
  let cursor;
  do {
    const page = await f.request(
      f.member,
      `${f.base}/inventory?sort=available&direction=desc&limit=20&count=exact${cursor ? `&cursor=${cursor}` : ''}`,
    );
    expect(page.totalCount).toBe(52);
    byAvailable.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  expect(new Set(byAvailable.map((item) => item.id)).size).toBe(52);
  const available = byAvailable.map(lowest);
  const reported = available.filter((value) => value !== null);
  expect(reported).toEqual([...reported].sort((a, b) => b - a));
  expect(
    available.slice(reported.length).every((value) => value === null),
  ).toBe(true);
  await f.request(
    f.member,
    `${f.base}/inventory?sort=onHand&cursor=${first.nextCursor}`,
    'GET',
    undefined,
    400,
  );
  const searched = await f.request(f.member, `${f.base}/inventory?q=SKU`);
  expect(searched.items).toEqual(first.items);
  const searchedNext = await f.request(
    f.member,
    `${f.base}/inventory?q=SKU&cursor=${searched.nextCursor}`,
  );
  expect(searchedNext.items).toEqual(next.items);
  const fromErp = await f.request(
    f.member,
    `${f.base}/inventory?connectionId=${stock.erp}`,
  );
  expect(fromErp.items).toEqual(
    positions.filter((item) =>
      item.sources.some((source) => source.connectionId === stock.erp),
    ),
  );
  expect(fromErp.items).toHaveLength(18);
  expect(fromErp.items.every((item) => item.sources.length === 2)).toBe(true);
  expect(fromErp.nextCursor).toBeNull();
  const last = positions.at(-1);
  expect(
    (
      await f.request(
        f.member,
        `${f.base}/inventory?skuId=${last.skuId}&locationId=${last.locationId}`,
      )
    ).items,
  ).toEqual([last]);
  expect(
    (await f.request(f.member, `${f.base}/inventory?view=differs`)).items,
  ).toEqual(fromErp.items);
  const unknown = await f.request(f.member, `${f.base}/inventory?view=unknown`);
  expect(unknown.items).toEqual(first.items);
  const unknownNext = await f.request(
    f.member,
    `${f.base}/inventory?view=unknown&cursor=${unknown.nextCursor}`,
  );
  expect(unknownNext.items).toEqual(next.items);
  await f.request(
    f.member,
    `${f.base}/inventory?q=SKU&cursor=${first.nextCursor}`,
    'GET',
    undefined,
    400,
  );
});

it('filters and groups positions by source quantities without treating missing as zero', async (t) => {
  const f = await settingsFixture(t);
  const stock = await inventoryFixture(t, f);
  await stock.stock({
    external: 'SKU-300',
    sku: 'SKU-300',
    location: 'Osaka',
    amount: '0',
    states: { tracked: false },
  });
  await stock.stock({
    connectionId: stock.erp,
    external: 'erp-301',
    sku: 'SKU-301',
    amount: '-1',
  });
  const where = (conditions, match = 'all') =>
    `where=${encodeURIComponent(JSON.stringify({ match, conditions }))}`;
  const labels = async (query) =>
    (await f.request(f.member, `${f.base}/inventory?${query}`)).items.map(
      (item) => `${item.sku}@${item.location}`,
    );

  expect(
    await labels(where([{ field: 'available', op: 'lte', value: 0 }])),
  ).toEqual(['SKU-300@Osaka', 'SKU-301@Tokyo']);
  expect(
    await labels(
      where([{ field: 'available', op: 'lte', value: 9, source: 'lowest' }]),
    ),
  ).toEqual(['SKU-100@Tokyo', 'SKU-300@Osaka', 'SKU-301@Tokyo']);
  expect(
    await labels(
      where([{ field: 'available', op: 'lte', value: 9, source: 'every' }]),
    ),
  ).toEqual(['SKU-300@Osaka', 'SKU-301@Tokyo']);
  // No source reports on-hand stock for these positions: unknown is never zero.
  expect(
    await labels(
      where([
        { field: 'onHand', op: 'eq', value: 0 },
        { field: 'tracked', op: 'is', value: false },
      ]),
    ),
  ).toEqual([]);
  expect(
    await labels(
      where([
        { field: 'source', op: 'any_of', value: [stock.erp] },
        {
          field: 'location',
          op: 'none_of',
          value: [stock.position.locationId],
        },
      ]),
    ),
  ).toEqual([]);

  const byLocation = await f.request(
    f.member,
    `${f.base}/inventory?group=location&groupLimit=1`,
  );
  const tokyo = byLocation.groups.find(
    (group) => group.key === stock.position.locationId,
  );
  expect(tokyo.count).toBe(2);
  expect(byLocation.groups.map((group) => group.count).sort()).toEqual([1, 2]);
  const rest = await f.request(
    f.member,
    `${f.base}/inventory?group=location&groupKey=${encodeURIComponent(JSON.stringify(tokyo.key))}&cursor=${tokyo.nextCursor}`,
  );
  expect(rest.items.map((item) => item.id)).not.toContain(tokyo.itemIds[0]);
  expect(rest.groups[0]).toMatchObject({ count: 2, nextCursor: null });
  const bySource = await f.request(
    f.member,
    `${f.base}/inventory?group=source`,
  );
  expect(
    Object.fromEntries(
      bySource.groups.map((group) => [group.key, group.count]),
    ),
  ).toEqual({ [stock.store]: 2, [stock.erp]: 2 });

  for (const query of [
    where([{ field: 'tracked', op: 'is', value: true, source: 'lowest' }]),
    where([{ field: 'sku', op: 'contains', value: 'SKU' }]),
    where([{ field: 'differences', op: 'any_of', value: ['committed'] }]),
    'group=available',
  ])
    await f.request(
      f.member,
      `${f.base}/inventory?${query}`,
      'GET',
      undefined,
      400,
    );
});
