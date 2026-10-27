import { expect, it } from 'vitest';

import { captureJson } from './capture.mjs';
import { inventoryFixture } from './inventory-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

// Set LUMA_INVENTORY_BENCHMARK to a position count (for example 20000) to time stock list reads
// through the API at that size. Every position has two sources.
it.skipIf(!process.env.LUMA_INVENTORY_BENCHMARK)(
  'reads a large stock list within the request budget',
  { timeout: 600_000 },
  async (t) => {
    const count = Number(process.env.LUMA_INVENTORY_BENCHMARK);
    const f = await settingsFixture(t);
    const stock = await inventoryFixture(t, f);
    // Copy each current source snapshot of the fixture position to new SKUs and locations.
    await f.db.owner.query(
      `INSERT INTO inventory_entities(id,tenant_id,kind,reconciliation_key)
       SELECT gen_random_uuid(),$1,kind,kind||'-bench-'||n FROM generate_series(1,$2::int) n,
       (VALUES ('sku'),('location')) k(kind) WHERE kind='sku' OR n<=50`,
      [f.org.id, count],
    );
    await f.db.owner.query(
      `WITH sources AS (
        SELECT s.* FROM inventory_projections p
        JOIN inventory_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
        WHERE p.tenant_id=$1 AND p.entity_id=$3
       ), targets AS (
        SELECT n,gen_random_uuid() AS entity_id,sku.id AS sku_id,loc.id AS location_id
        FROM generate_series(1,$2::int) n
        JOIN inventory_entities sku ON sku.tenant_id=$1 AND sku.reconciliation_key='sku-bench-'||n
        JOIN inventory_entities loc ON loc.tenant_id=$1 AND loc.reconciliation_key='location-bench-'||(n%50+1)
       ), entities AS (
        INSERT INTO inventory_entities(id,tenant_id,kind,reconciliation_key)
        SELECT entity_id,$1,'position','position-bench-'||n FROM targets RETURNING id
       ), snapshots AS (
        INSERT INTO inventory_snapshots(id,tenant_id,entity_id,kind,connection_id,observation_id,
         normalizer_version,mapping_version,source_updated_at,observed_at,document)
        SELECT gen_random_uuid(),$1,t.entity_id,'position',s.connection_id,s.observation_id,
         s.normalizer_version,s.mapping_version,s.source_updated_at,s.observed_at,
         jsonb_set(jsonb_set(jsonb_set(jsonb_set(s.document,'{entityId}',to_jsonb(t.entity_id::text)),
          '{data,skuId}',to_jsonb(t.sku_id::text)),'{data,locationId}',to_jsonb(t.location_id::text)),
          '{data,available}',to_jsonb(((t.n*7)%40-5)::text))
        FROM targets t CROSS JOIN sources s WHERE EXISTS(SELECT 1 FROM entities e WHERE e.id=t.entity_id)
        RETURNING id,entity_id,connection_id
       )
       INSERT INTO inventory_projections(tenant_id,entity_id,connection_id,snapshot_id)
       SELECT $1,entity_id,connection_id,id FROM snapshots`,
      [f.org.id, count, stock.position.id],
    );
    await f.db.owner.query('ANALYZE');
    const timings = {};
    const time = async (name, path) => {
      const runs = [];
      let body;
      for (let run = 0; run < 3; run++) {
        const start = performance.now();
        body = await f.request(f.member, `${f.base}/inventory${path}`);
        runs.push(performance.now() - start);
      }
      timings[name] = Math.round(Math.min(...runs));

      return body;
    };
    const where = (conditions) =>
      `?where=${encodeURIComponent(JSON.stringify({ match: 'all', conditions }))}`;
    const first = await time('first page', '');
    expect(first.items).toHaveLength(50);
    await time('second page', `?cursor=${first.nextCursor}`);
    await time('sorted by available', '?sort=available');
    await time('exact count', '?count=exact');
    await time(
      'available at most zero in any source',
      where([{ field: 'available', op: 'lte', value: 0 }]),
    );
    await time(
      'lowest available below five',
      where([{ field: 'available', op: 'lt', value: 5, source: 'lowest' }]),
    );
    await time(
      'differs in available',
      where([{ field: 'differences', op: 'any_of', value: ['available'] }]),
    );
    await time('grouped by location', '?group=location');
    await time('grouped by SKU', '?group=sku');
    await time('grouped by source', '?group=source');
    await time('search', '?q=sku-bench-123');
    await captureJson(`inventory-benchmark-${count}.json`, { count, timings });
  },
);
