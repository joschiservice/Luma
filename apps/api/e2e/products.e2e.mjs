import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { productsFixture } from './products-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

it('compares catalog listings by source, finds gaps and follows related records', async (t) => {
  const f = await settingsFixture(t);
  const catalog = await productsFixture(t, f);
  const list = await f.request(f.member, `${f.base}/products`);
  expect(list.counts).toEqual({ all: 6, differs: 1, missing: 4, unlinked: 2 });
  expect(list.items.map((item) => item.sku)).toEqual([
    'APR-M',
    'APR-S',
    'gift-box',
    'GIFT-BOX ',
    'SCARF-1',
    'SKU-100',
  ]);
  expect(list.sources.map((source) => [source.label, source.skuCount])).toEqual(
    [
      ['JTL-Wawi', 3],
      ['Tokyo store', 5],
    ],
  );
  // Count sorts run in both directions; SKUs without a code or price come last.
  const listings = (
    await f.request(f.member, `${f.base}/products?sort=listings&direction=desc`)
  ).items.map((item) => item.listings.length);
  expect(listings).toEqual([...listings].sort((a, b) => b - a));
  const lowest = (item) =>
    item.listings
      .filter((listing) => listing.price?.currency)
      .map((listing) => [listing.price.currency, Number(listing.price.amount)])
      .sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1])[0] ?? null;
  const prices = (
    await f.request(f.member, `${f.base}/products?sort=price`)
  ).items.map(lowest);
  const priced = prices.filter((price) => price !== null);
  expect(priced).toEqual(
    [...priced].sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]),
  );
  expect(prices.slice(priced.length).every((price) => price === null)).toBe(
    true,
  );
  const tote = list.items.find((item) => item.sku === 'SKU-100');
  // Prices without a currency and barcodes with leading zeros are not differences.
  expect(tote.differences).toEqual(['title', 'published']);
  expect(tote.listings).toHaveLength(2);
  expect(tote.gaps).toEqual([]);
  const store = tote.listings.find((l) => l.connectionId === catalog.store);
  expect(store).toMatchObject({
    externalProduct: 'gid://shopify/Product/1',
    externalSku: 'SKU-100',
    price: { amount: '26.00', currency: 'EUR' },
    status: 'active',
    published: true,
  });
  const apron = list.items.find((item) => item.sku === 'APR-S');
  expect(apron.differences).toEqual([]);
  expect(list.items.find((item) => item.sku === 'APR-M').gaps).toEqual([
    { connectionId: catalog.erp, match: null },
  ]);
  const gift = list.items.find((item) => item.sku === 'gift-box');
  expect(gift.gaps).toEqual([
    {
      connectionId: catalog.erp,
      match: { skuId: expect.any(String), sku: 'GIFT-BOX ' },
    },
  ]);

  const differs = await f.request(f.member, `${f.base}/products?view=differs`);
  expect(differs.items.map((item) => item.sku)).toEqual(['SKU-100']);
  const missing = await f.request(
    f.member,
    `${f.base}/products?view=missing&missingFrom=${catalog.erp}`,
  );
  expect(missing.items.map((item) => item.sku)).toEqual([
    'APR-M',
    'gift-box',
    'SCARF-1',
  ]);
  const searched = await f.request(
    f.member,
    `${f.base}/products?q=apron&connectionId=${catalog.erp}`,
  );
  expect(searched.items.map((item) => item.sku)).toEqual(['APR-S']);
  expect(searched.items[0].listings).toHaveLength(2);
  for (const q of ['0012345678905', 'gid://shopify/Product/2', 'Luma Goods'])
    expect(
      (
        await f.request(
          f.member,
          `${f.base}/products?q=${encodeURIComponent(q)}`,
        )
      ).items.length,
    ).toBeGreaterThan(0);
  expect(
    (await f.request(f.member, `${f.base}/products?q=%25`)).items,
  ).toHaveLength(0);

  const detail = await f.request(f.member, `${f.base}/products/${tote.skuId}`);
  expect(detail.item.skuId).toBe(catalog.skuId);
  expect(detail.stock).toHaveLength(1);
  expect(detail.stock[0].sources).toHaveLength(2);
  expect(detail.orders.map((order) => order.label).sort()).toEqual([
    '#100',
    '#101',
  ]);
  expect(detail.sales.sources).toEqual([
    {
      connectionId: catalog.store,
      unit: 'each',
      orders: 1,
      quantity: '3',
      lastPlacedAt: expect.any(String),
      daily: [{ date: expect.any(String), quantity: '3' }],
    },
  ]);
  // The earlier Shopify price remains visible as history.
  expect(
    detail.history.entries
      .filter((entry) => entry.connectionId === catalog.store)
      .map((entry) => [entry.price?.amount, entry.current]),
  ).toEqual([
    ['26.00', true],
    ['24.00', false],
  ]);
  const apronDetail = await f.request(
    f.member,
    `${f.base}/products/${apron.skuId}`,
  );
  expect(apronDetail.variants.map((variant) => variant.sku)).toEqual(['APR-M']);

  await catalog.link(gift.skuId, gift.gaps[0].match.skuId);
  const linked = await f.request(f.member, `${f.base}/products?view=unlinked`);
  expect(linked.counts).toMatchObject({ all: 5, unlinked: 0, missing: 2 });
  const merged = await f.request(f.member, `${f.base}/products/${gift.skuId}`);
  expect(merged.item.listings).toHaveLength(2);
  expect(merged.item.gaps).toEqual([]);

  const page = await f.request(f.member, `${f.base}/products?view=missing`);
  expect(page.nextCursor).toBeNull();
  await f.request(
    f.member,
    `${f.base}/products?cursor=broken`,
    'GET',
    undefined,
    400,
  );
  await f.request(f.outsider, `${f.base}/products`, 'GET', undefined, 404);
  await f.request(
    f.outsider,
    `${f.base}/products/${tote.skuId}`,
    'GET',
    undefined,
    404,
  );
  await f.request(
    f.member,
    `${f.base}/products/${randomUUID()}`,
    'GET',
    undefined,
    404,
  );
  // A SKU known only from stock or orders still has a detail page without listings.
  const stockOnly = await catalog.stock({
    external: 'SKU-200',
    sku: 'SKU-200',
  });
  const bare = await f.request(f.member, `${f.base}/products/${stockOnly}`);
  expect(bare.item.listings).toEqual([]);
  expect(bare.item.gaps).toHaveLength(2);
  expect(bare.stock).toHaveLength(1);
});

it('pages a large catalog with a cursor bound to its filters', async (t) => {
  const f = await settingsFixture(t);
  const catalog = await productsFixture(t, f);
  await catalog.product({
    connectionId: catalog.store,
    external: 'gid://shopify/Product/99',
    title: 'Bulk',
    skus: Array.from({ length: 60 }, (_, index) => ({
      external: `BULK-${index}`,
      key: `BULK-${index}`,
      code: `BULK-${String(index).padStart(2, '0')}`,
    })),
  });
  const first = await f.request(f.member, `${f.base}/products`);
  expect(first.items).toHaveLength(50);
  expect(first.counts.all).toBe(66);
  const second = await f.request(
    f.member,
    `${f.base}/products?cursor=${first.nextCursor}`,
  );
  expect(second.items).toHaveLength(16);
  expect(second.nextCursor).toBeNull();
  expect(
    new Set([...first.items, ...second.items].map((item) => item.skuId)).size,
  ).toBe(66);
  await f.request(
    f.member,
    `${f.base}/products?view=missing&cursor=${first.nextCursor}`,
    'GET',
    undefined,
    400,
  );
});

it('filters and groups products by listing conditions per source', async (t) => {
  const f = await settingsFixture(t);
  const catalog = await productsFixture(t, f);
  const where = (conditions, match = 'all') =>
    `where=${encodeURIComponent(JSON.stringify({ match, conditions }))}`;
  const skus = async (query) =>
    (await f.request(f.member, `${f.base}/products?${query}`)).items.map(
      (item) => item.sku,
    );

  expect(
    await skus(where([{ field: 'status', op: 'any_of', value: ['draft'] }])),
  ).toEqual(['SCARF-1']);
  // A named source scope reads only that source's listing.
  expect(
    await skus(
      where([
        {
          field: 'published',
          op: 'is',
          value: false,
          source: catalog.erp,
        },
      ]),
    ),
  ).toEqual(['SKU-100']);
  expect(
    await skus(
      where([
        { field: 'price', op: 'lt', value: { amount: '20', currency: 'EUR' } },
      ]),
    ),
  ).toEqual(['APR-M', 'APR-S']);
  expect(
    await skus(
      where([{ field: 'listings', op: 'any_of', value: [catalog.erp] }]),
    ),
  ).toEqual(['APR-S', 'GIFT-BOX ', 'SKU-100']);
  const filtered = await f.request(
    f.member,
    `${f.base}/products?${where([{ field: 'vendor', op: 'is', value: 'Luma Goods' }])}`,
  );
  expect(filtered.counts).toMatchObject({ all: 1, differs: 1 });

  const grouped = await f.request(
    f.member,
    `${f.base}/products?group=status&groupLimit=2`,
  );
  expect(grouped.groups.map((group) => [group.key, group.count])).toEqual([
    ['active', 5],
    ['draft', 1],
  ]);
  const active = grouped.groups[0];
  expect(active.itemIds).toHaveLength(2);
  const more = await f.request(
    f.member,
    `${f.base}/products?group=status&groupKey=${encodeURIComponent('"active"')}&limit=3&cursor=${active.nextCursor}`,
  );
  expect(more.items).toHaveLength(3);
  expect(more.groups).toEqual([
    expect.objectContaining({ key: 'active', count: 5, nextCursor: null }),
  ]);
  expect(
    new Set([...active.itemIds, ...more.items.map((item) => item.skuId)]).size,
  ).toBe(5);

  for (const query of [
    where([{ field: 'title', op: 'contains', value: 'tote' }]),
    where([{ field: 'updated', op: 'empty', source: catalog.erp }]),
    where([
      {
        field: 'price',
        op: 'gt',
        value: { amount: '1', currency: 'EUR' },
        source: 'lowest',
      },
    ]),
    where([{ field: 'status', op: 'any_of', value: ['retired'] }]),
    'group=sku',
    `groupKey=${encodeURIComponent('"active"')}`,
    `group=status&cursor=${active.nextCursor}`,
  ])
    await f.request(
      f.member,
      `${f.base}/products?${query}`,
      'GET',
      undefined,
      400,
    );
});
