import { writeFile } from 'node:fs/promises';

import { expect, it } from 'vitest';

import { customersFixture } from './customers-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

/** Encodes list conditions and grouping as the list API expects them. */
const conditions = (match, ...items) =>
  `where=${encodeURIComponent(JSON.stringify({ match, conditions: items }))}`;

// Set LUMA_CUSTOMER_BENCHMARK to a profile count (for example 50000) to time customer reads
// through the API at that size, with countries, tags, amounts and last order dates spread out.
it.skipIf(!process.env.LUMA_CUSTOMER_BENCHMARK)(
  'reads many customers within the request budget',
  { timeout: 600_000 },
  async (t) => {
    const count = Number(process.env.LUMA_CUSTOMER_BENCHMARK);
    const f = await settingsFixture(t);
    const c = await customersFixture(f);
    await f.db.owner.query(
      `INSERT INTO customer_profiles(tenant_id,connection_id,external_id,id,display_name,email,phone,address,state,
        source_created_at,order_count,amount_spent,currency,tags,contact_shared,address_shared,observed_at,
        observation_id,last_order_at)
       SELECT $1,$2,'bench-'||n,gen_random_uuid(),'Bench Customer '||n,'bench'||n||'@example.test',NULL,
        CASE WHEN n%7=0 THEN NULL ELSE jsonb_build_object('line1',NULL,'line2',NULL,'city',NULL,'region',NULL,
         'postalCode',NULL,'country',(ARRAY['DE','AT','CH','JP','US','FR'])[1+n%6]) END,
        (ARRAY['enabled','disabled','invited','declined','unknown'])[1+n%5],now()-n*interval '1 hour',n%40,
        (n%500)::numeric,(ARRAY['EUR','USD'])[1+n%2],ARRAY[(ARRAY['VIP','B2B','Newsletter','Wholesale'])[1+n%4]],
        true,n%7<>0,now(),gen_random_uuid(),CASE WHEN n%3=0 THEN NULL ELSE now()-(n%900)*interval '1 day' END
       FROM generate_series(1,$3::int) n`,
      [f.org.id, c.vienna, count],
    );
    await f.db.owner.query('ANALYZE');
    const timings = {};
    const time = async (name, path) => {
      const runs = [];
      let body;
      for (let run = 0; run < 3; run++) {
        const start = performance.now();
        body = await f.request(f.member, `${f.base}/customers${path}`);
        runs.push(performance.now() - start);
      }
      timings[name] = Math.round(Math.min(...runs));

      return body;
    };
    const first = await time('newest first', '');
    expect(first.totalCount).toBeGreaterThan(count);
    await time('deep page', `?cursor=${first.nextCursor}`);
    await time('search', '?q=customer%201234');
    await time('last order, newest first', '?sort=lastOrder');
    await time(
      'country and tag conditions',
      `?${conditions(
        'all',
        { field: 'country', op: 'any_of', value: ['DE', 'AT'] },
        { field: 'tags', op: 'any_of', value: ['VIP'] },
      )}`,
    );
    await time(
      'amount range',
      `?${conditions('all', {
        field: 'spent',
        op: 'between',
        value: {
          from: { amount: '100', currency: 'EUR' },
          to: { amount: '200', currency: 'EUR' },
        },
      })}`,
    );
    await time(
      'ordered within 90 days',
      `?${conditions('all', {
        field: 'lastOrder',
        op: 'within_last',
        value: { amount: 90, unit: 'day' },
      })}`,
    );
    await time('state groups', '?group=state');
    await time('tag groups', '?group=tags');
    const countries = await time('country groups', '?group=country');
    const group = countries.groups.find((item) => item.nextCursor);
    await time(
      'page within a group',
      `?group=country&groupKey=${encodeURIComponent(JSON.stringify(group.key))}&cursor=${group.nextCursor}`,
    );
    await writeFile(
      `/tmp/luma317-customers-${count}.json`,
      JSON.stringify({ count, timings }, null, 2),
    );
  },
);
