import { writeFile } from 'node:fs/promises';

import { expect, it } from 'vitest';

import { returnsFixture } from './returns-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

// Set LUMA_RETURN_BENCHMARK to a return count (for example 20000) to time return reads through
// the API at that size. Copies of one return spread across stages and request dates.
it.skipIf(!process.env.LUMA_RETURN_BENCHMARK)(
  'reads many returns within the request budget',
  { timeout: 600_000 },
  async (t) => {
    const count = Number(process.env.LUMA_RETURN_BENCHMARK);
    const f = await settingsFixture(t);
    const r = await returnsFixture(t, f);
    await f.db.owner.query(
      `WITH template AS (
        SELECT r.*,s.document,s.observation_id,s.mapping_version FROM orders_returns r
        JOIN orders_snapshots s ON s.tenant_id=r.tenant_id AND s.id=r.snapshot_id
        WHERE r.tenant_id=$1 AND r.entity_id=$2
      ), entities AS (
        INSERT INTO orders_entities(id,tenant_id,kind,reconciliation_key)
        SELECT gen_random_uuid(),$1,'return','bench-' || n FROM generate_series(1,$3::int) n
        RETURNING id,substr(reconciliation_key,7)::int AS n
      ), snapshots AS (
        INSERT INTO orders_snapshots(id,tenant_id,entity_id,kind,connection_id,observation_id,normalizer_version,
         mapping_version,source_updated_at,observed_at,document)
        SELECT gen_random_uuid(),$1,e.id,'return',t.connection_id,t.observation_id,'bench/1',t.mapping_version,
         NULL,now(),jsonb_set(t.document,'{entityId}',to_jsonb(e.id::text))
        FROM entities e CROSS JOIN template t RETURNING id,entity_id,connection_id
      ), projected AS (
        INSERT INTO orders_projections(tenant_id,entity_id,connection_id,snapshot_id)
        SELECT $1,entity_id,connection_id,id FROM snapshots RETURNING entity_id,snapshot_id
      )
      INSERT INTO orders_returns(tenant_id,entity_id,connection_id,snapshot_id,order_id,kind,name,order_number,status,
       stage,stage_group,refund_state,quantity,received,refunded_units,value_amount,value_currency,currency,
       refunded_amount,pending_amount,failed_attempts,reasons,requested_at,requested_key,activity_at,observed_at,
       source_updated_at,deleted)
      SELECT $1,p.entity_id,t.connection_id,p.snapshot_id,t.order_id,'return','#B' || e.n || '-R1','#B' || e.n,
       t.status,(ARRAY['requested','awaiting_items','awaiting_refund','refund_pending','closed','closed'])[1 + e.n % 6],
       (ARRAY['action','waiting','action','waiting','done','done'])[1 + e.n % 6],t.refund_state,t.quantity,
       t.received,t.refunded_units,t.value_amount,t.value_currency,t.currency,t.refunded_amount,t.pending_amount,
       t.failed_attempts,ARRAY[(ARRAY['Defective','Size too small','Changed mind'])[1 + e.n % 3]],
       now() - e.n * interval '1 hour',now() - e.n * interval '1 hour',
       now() - e.n * interval '30 minutes',now(),NULL,false
      FROM projected p JOIN entities e ON e.id=p.entity_id CROSS JOIN template t`,
      [f.org.id, r.returns.received, count],
    );
    await f.db.owner.query('ANALYZE');
    const timings = {};
    const time = async (name, path) => {
      const runs = [];
      let body;
      for (let run = 0; run < 3; run++) {
        const start = performance.now();
        body = await f.request(f.member, `${f.base}/returns${path}`);
        runs.push(performance.now() - start);
      }
      timings[name] = Math.round(Math.min(...runs));

      return body;
    };
    const first = await time('needs action, oldest first', '?direction=asc');
    expect(first.counts.views.all).toBeGreaterThan(count);
    const all = await time('all, newest first', '?view=all');
    await time('stage filter', '?view=all&stage=refund_pending');
    await time('search by order number', '?view=all&q=%23B1234');
    await time('deep page', `?view=all&cursor=${all.nextCursor}`);
    await time('detail', `/${r.returns.received}`);
    const where = (...conditions) =>
      `where=${encodeURIComponent(JSON.stringify({ match: 'all', conditions }))}`;
    await time(
      'value and reason conditions',
      `?view=all&${where(
        { field: 'value', op: 'gte', value: { amount: '40', currency: 'EUR' } },
        { field: 'reasons', op: 'any_of', value: ['Defective'] },
      )}`,
    );
    await time(
      'requested this week',
      `?view=all&${where({ field: 'requested', op: 'within_last', value: { amount: 7, unit: 'day' } })}`,
    );
    const stages = await time('stage board', '?view=all&group=stage');
    await time('reason groups', '?view=all&group=reasons');
    const group = stages.groups.find((item) => item.nextCursor);
    await time(
      'page within a group',
      `?view=all&group=stage&groupKey=${encodeURIComponent(JSON.stringify(group.key))}&cursor=${group.nextCursor}`,
    );
    await f.db.owner.query(
      `INSERT INTO customer_profiles(tenant_id,connection_id,external_id,id,display_name,email,state,contact_shared,
        address_shared,observed_at,observation_id)
       VALUES($1,$2,'gid://shopify/Customer/5',gen_random_uuid(),'Mira Sato','mira@example.test','enabled',true,false,now(),gen_random_uuid())`,
      [f.org.id, r.store],
    );
    await f.db.owner.query(
      `INSERT INTO customer_orders(tenant_id,connection_id,order_scope_key,order_external_id,customer_external_id,observed_at)
       VALUES($1,$2,'','gid://shopify/Order/1002','gid://shopify/Customer/5',now())`,
      [f.org.id, r.store],
    );
    await time('search by customer name', '?view=all&q=Mira');
    await writeFile(
      `/tmp/luma103-returns-${count}.json`,
      JSON.stringify({ count, timings }, null, 2),
    );
  },
);
