import { expect, it } from 'vitest';

import { captureJson } from './capture.mjs';
import { productsFixture } from './products-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

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
    const where = (conditions) =>
      `?where=${encodeURIComponent(JSON.stringify({ match: 'all', conditions }))}`;
    await time(
      'status in every source',
      where([
        { field: 'status', op: 'any_of', value: ['active'], source: 'every' },
      ]),
    );
    await time(
      'price range in one source',
      where([
        {
          field: 'price',
          op: 'between',
          value: {
            from: { amount: '12', currency: 'EUR' },
            to: { amount: '14', currency: 'EUR' },
          },
          source: catalog.store,
        },
      ]),
    );
    await time(
      'differing field',
      where([{ field: 'differences', op: 'any_of', value: ['status'] }]),
    );
    await time('grouped by status', '?group=status');
    await time('grouped by differing field', '?group=differences');
    await captureJson(`products-benchmark-${count}.json`, { count, timings });
  },
);
