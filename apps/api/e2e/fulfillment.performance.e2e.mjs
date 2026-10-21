import { writeFile } from 'node:fs/promises';

import { expect, it } from 'vitest';

import { fulfillmentFixture } from './fulfillment-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

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
