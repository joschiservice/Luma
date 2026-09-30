import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

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

// Set LUMA_PRODUCT_BENCHMARK to a SKU count (for example 20000) to time catalog reads through
// the API at that size. Each SKU is listed in both sources; a tenth only have an unlinked match.
it.skipIf(!process.env.LUMA_PRODUCT_BENCHMARK)(
  'reads a large catalog within the request budget',
  { timeout: 600_000 },
  async (t) => {
    const count = Number(process.env.LUMA_PRODUCT_BENCHMARK);
    const f = await settingsFixture(t);
    const catalog = await productsFixture(t, f);
    const templates = await f.db.owner.query(
      `SELECT DISTINCT ON (connection_id) product_id,connection_id,snapshot_id FROM inventory_product_skus
       WHERE tenant_id=$1 ORDER BY connection_id`,
      [f.org.id],
    );
    await f.db.owner.query(
      `INSERT INTO inventory_entities(id,tenant_id,kind,reconciliation_key)
       SELECT gen_random_uuid(),$1,'sku',key FROM generate_series(1,$2::int) n,
       LATERAL (VALUES ('bench-shared-'||n),(CASE WHEN n%10=0 THEN 'bench-own-'||n END)) k(key)
       WHERE key IS NOT NULL`,
      [f.org.id, count],
    );
    for (const row of templates.rows) {
      const erp = row.connection_id === catalog.erp;
      await f.db.owner.query(
        `INSERT INTO inventory_product_skus(tenant_id,product_id,connection_id,sku_id,code,snapshot_id,
          product_title,product_status,published,variant_title,price_amount,price_currency,unit,observed_at)
         SELECT $1,$2,$3,e.id,'BENCH-'||n,$4,'Product '||(n/5),
          CASE WHEN $6 AND n%37=0 THEN 'archived' ELSE 'active' END,true,'Size '||(n%5),10+(n%7),
          CASE WHEN $6 THEN NULL ELSE 'EUR' END,'each',now()
         FROM generate_series(1,$5::int) n
         JOIN inventory_entities e ON e.tenant_id=$1 AND e.kind='sku' AND e.reconciliation_key=
          CASE WHEN $6 AND n%10=0 THEN 'bench-own-'||n ELSE 'bench-shared-'||n END`,
        [
          f.org.id,
          row.product_id,
          row.connection_id,
          row.snapshot_id,
          count,
          erp,
        ],
      );
    }
    await f.db.owner.query('ANALYZE');
    const timings = {};
    const time = async (name, path) => {
      const runs = [];
      let body;
      for (let run = 0; run < 3; run++) {
        const start = performance.now();
        body = await f.request(f.member, `${f.base}/products${path}`);
        runs.push(performance.now() - start);
      }
      timings[name] = Math.round(Math.min(...runs));

      return body;
    };
    const first = await time('first page', '');
    expect(first.counts.all).toBeGreaterThan(count);
    await time('differs view', '?view=differs');
    await time('unlinked view', '?view=unlinked');
    await time('selective search', '?q=BENCH-1234');
    await time('broad search', '?q=Product');
    const second = await time('second page', `?cursor=${first.nextCursor}`);
    await time('deep page', `?cursor=${second.nextCursor}`);
    await time('detail', `/${catalog.skuId}`);
    await writeFile(
      `/tmp/luma101-products-${count}.json`,
      JSON.stringify({ count, timings }, null, 2),
    );
  },
);
