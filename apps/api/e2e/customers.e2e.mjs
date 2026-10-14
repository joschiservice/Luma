import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import { expect, it } from 'vitest';

import { settingsFixture } from './settings-fixture.mjs';

/**
 * Adds a Shopify store that shares customers, a second store and a JTL connection that does not,
 * and stores imported profiles as the customers owner does after a sync.
 */
async function customersFixture(f) {
  const tokyo = randomUUID();
  const vienna = randomUUID();
  const erp = randomUUID();
  for (const [id, provider, label, reads] of [
    [tokyo, 'shopify', 'Tokyo store', ['orders.read', 'customers.read']],
    [vienna, 'shopify', 'Vienna store', ['orders.read', 'customers.read']],
    [erp, 'jtl', 'JTL-Wawi', ['orders.read']],
  ]) {
    await f.db.owner.query(
      "INSERT INTO workspace_apps(tenant_id,app_id,status,version) VALUES($1,$2,'installed',1) ON CONFLICT DO NOTHING",
      [f.org.id, provider],
    );
    await f.db.owner.query(
      'INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,1,$3,$4)',
      [
        f.org.id,
        id,
        {
          id,
          tenantId: f.org.id,
          version: 1,
          status: 'active',
          appId: provider,
          appInstallationVersion: 1,
          provider,
          target: { kind: provider },
          label,
          permissions: reads,
          granted: reads,
        },
        'fixture',
      ],
    );
  }
  const ids = {};
  for (const [key, connectionId, externalId, values] of [
    [
      'avery',
      tokyo,
      'gid://shopify/Customer/71',
      {
        name: 'Avery Tan',
        email: 'Avery@Example.test',
        phone: '+81 3 1234 5678',
        state: 'enabled',
        created: '2025-03-14T09:30:00Z',
        orders: 8,
        spent: '482.000000',
        tags: ['VIP'],
        address: {
          line1: '1-2-3 Jingumae',
          line2: null,
          city: 'Shibuya',
          region: 'Tokyo',
          postalCode: '150-0001',
          country: 'Japan',
        },
      },
    ],
    [
      'jonas',
      vienna,
      'gid://shopify/Customer/72',
      {
        name: 'Jonas Weber',
        email: 'jonas@example.test',
        phone: null,
        state: 'disabled',
        created: '2026-09-01T10:00:00Z',
        orders: 1,
        spent: '39.900000',
        tags: [],
        address: null,
      },
    ],
    [
      // The same person in another store stays a separate customer.
      'averyVienna',
      vienna,
      'gid://shopify/Customer/91',
      {
        name: 'Avery Tan',
        email: 'avery@example.test',
        phone: null,
        state: 'invited',
        created: '2026-01-05T08:00:00Z',
        orders: 2,
        spent: '60.000000',
        tags: [],
        address: null,
      },
    ],
    [
      // Contact details withheld by the source.
      'withheld',
      tokyo,
      'gid://shopify/Customer/73',
      {
        name: null,
        email: null,
        phone: null,
        state: 'unknown',
        created: null,
        orders: null,
        spent: null,
        tags: [],
        address: null,
      },
    ],
  ]) {
    ids[key] = randomUUID();
    const shared = values.name !== null;
    await f.db.owner.query(
      `INSERT INTO customer_profiles(tenant_id,connection_id,external_id,id,display_name,email,phone,address,state,
        source_created_at,order_count,amount_spent,currency,tags,contact_shared,address_shared,source_updated_at,
        observed_at,observation_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NULL,now(),$17)`,
      [
        f.org.id,
        connectionId,
        externalId,
        ids[key],
        values.name,
        values.email,
        values.phone,
        values.address,
        values.state,
        values.created,
        values.orders,
        values.spent,
        values.spent === null ? null : 'EUR',
        values.tags,
        shared,
        shared,
        randomUUID(),
      ],
    );
  }

  return { tokyo, vienna, erp, ids };
}

const names = (list) =>
  list.items.map((item) => item.displayName ?? item.externalId);

it('lists imported customers per store with search, filters, sorting and their sources', async (t) => {
  const f = await settingsFixture(t);
  const c = await customersFixture(f);
  const all = await f.request(f.member, `${f.base}/customers`);
  // Newest source customers first; profiles without a creation time come last.
  expect(names(all)).toEqual([
    'Jonas Weber',
    'Avery Tan',
    'Avery Tan',
    'gid://shopify/Customer/73',
  ]);
  expect(all.totalCount).toBe(4);
  expect(all.nextCursor).toBeNull();
  expect(all.items[2]).toEqual({
    id: c.ids.avery,
    connectionId: c.tokyo,
    externalId: 'gid://shopify/Customer/71',
    displayName: 'Avery Tan',
    email: 'Avery@Example.test',
    phone: '+81 3 1234 5678',
    state: 'enabled',
    sourceCreatedAt: '2025-03-14T09:30:00.000Z',
    orderCount: 8,
    amountSpent: { amount: '482', currency: 'EUR' },
    tags: ['VIP'],
    shared: { contact: true, address: true },
    sourceUpdatedAt: null,
    observedAt: expect.any(String),
    missingSince: null,
    country: 'JAPAN',
    lastOrderAt: null,
  });
  expect(all.items[3]).toMatchObject({
    displayName: null,
    email: null,
    orderCount: null,
    amountSpent: null,
    shared: { contact: false, address: false },
  });
  // JTL is listed so missing customer access is visible.
  expect(
    all.sources.map((source) => [source.label, source.access, source.records]),
  ).toEqual([
    ['JTL-Wawi', 'not_requested', 0],
    ['Tokyo store', 'granted', 2],
    ['Vienna store', 'granted', 2],
  ]);

  for (const [q, expected] of [
    ['avery', 2],
    ['AVERY@EXAMPLE', 2],
    ['1234', 1],
    ['72', 1],
    ['gid://shopify/Customer/73', 1],
    ['Customer/7', 0],
    ['%', 0],
  ])
    expect(
      (
        await f.request(
          f.member,
          `${f.base}/customers?q=${encodeURIComponent(q)}`,
        )
      ).totalCount,
      q,
    ).toBe(expected);

  expect(
    names(
      await f.request(f.member, `${f.base}/customers?connectionId=${c.vienna}`),
    ),
  ).toEqual(['Jonas Weber', 'Avery Tan']);
  expect(
    names(await f.request(f.member, `${f.base}/customers?state=invited`)),
  ).toEqual(['Avery Tan']);
  expect(
    (await f.request(f.member, `${f.base}/customers?sort=orders`)).items.map(
      (item) => item.orderCount,
    ),
  ).toEqual([8, 2, 1, null]);
  // Customers without a value come last in both directions.
  expect(
    (
      await f.request(f.member, `${f.base}/customers?sort=orders&direction=asc`)
    ).items.map((item) => item.orderCount),
  ).toEqual([1, 2, 8, null]);
  expect(
    names(
      await f.request(f.member, `${f.base}/customers?sort=name&direction=asc`),
    ),
  ).toEqual([
    'Avery Tan',
    'Avery Tan',
    'Jonas Weber',
    'gid://shopify/Customer/73',
  ]);
  const spent = (
    await f.request(f.member, `${f.base}/customers?sort=amountSpent`)
  ).items.map((item) => item.amountSpent);
  const reported = spent.filter((amount) => amount !== null);
  expect(spent.slice(reported.length).every((amount) => amount === null)).toBe(
    true,
  );
  expect(reported).toEqual(
    [...reported].sort(
      (a, b) =>
        b.currency.localeCompare(a.currency) ||
        Number(b.amount) - Number(a.amount),
    ),
  );

  // A source customer link resolves to exactly one profile in that store.
  const linked = await f.request(
    f.member,
    `${f.base}/customers?connectionId=${c.vienna}&externalId=${encodeURIComponent('gid://shopify/Customer/91')}`,
  );
  expect(linked.items.map((item) => item.id)).toEqual([c.ids.averyVienna]);
  expect(
    (
      await f.request(
        f.member,
        `${f.base}/customers?connectionId=${c.tokyo}&externalId=${encodeURIComponent('gid://shopify/Customer/91')}`,
      )
    ).items,
  ).toEqual([]);
  await f.request(
    f.member,
    `${f.base}/customers?externalId=${encodeURIComponent('gid://shopify/Customer/91')}`,
    'GET',
    undefined,
    400,
  );

  const detail = await f.request(
    f.member,
    `${f.base}/customers/${c.ids.avery}`,
  );
  expect(detail).toMatchObject({
    item: { id: c.ids.avery, displayName: 'Avery Tan' },
    address: { city: 'Shibuya', postalCode: '150-0001' },
    source: { connectionId: c.tokyo, label: 'Tokyo store', access: 'granted' },
  });
  expect(
    (await f.request(f.member, `${f.base}/customers/${c.ids.withheld}`))
      .address,
  ).toBeNull();
});

it('pages with a cursor bound to its filters and keeps other tenants and roles out', async (t) => {
  const f = await settingsFixture(t);
  const c = await customersFixture(f);
  for (const sort of ['created', 'orders', 'name']) {
    const first = await f.request(
      f.member,
      `${f.base}/customers?sort=${sort}&limit=3`,
    );
    expect(first.items).toHaveLength(3);
    expect(first.totalCount).toBe(4);
    const second = await f.request(
      f.member,
      `${f.base}/customers?sort=${sort}&limit=3&cursor=${first.nextCursor}`,
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((item) => item.id)).size,
      sort,
    ).toBe(4);
  }
  const first = await f.request(f.member, `${f.base}/customers?limit=2`);
  await f.request(
    f.member,
    `${f.base}/customers?limit=2&state=enabled&cursor=${first.nextCursor}`,
    'GET',
    undefined,
    400,
  );
  await f.request(f.outsider, `${f.base}/customers`, 'GET', undefined, 404);
  await f.request(
    f.outsider,
    `${f.base}/customers/${c.ids.avery}`,
    'GET',
    undefined,
    404,
  );
  await f.request(
    f.member,
    `${f.base}/customers/${randomUUID()}`,
    'GET',
    undefined,
    404,
  );

  // A role without customer access can't read profiles.
  const created = await f.app.inject({
    method: 'POST',
    url: `${f.base}/roles`,
    headers: {
      origin: f.config.baseURL,
      cookie: f.owner.cookie,
      'x-command-id': randomUUID(),
    },
    payload: {
      name: 'Orders only',
      description: '',
      permissions: ['orders.read'],
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const role = created.json();
  await f.request(f.owner, `${f.base}/members/${f.membership.id}`, 'PATCH', {
    roleId: role.id,
  });
  await f.request(f.member, `${f.base}/customers`, 'GET', undefined, 403);
  await f.request(
    f.member,
    `${f.base}/customers/${c.ids.avery}`,
    'GET',
    undefined,
    403,
  );
});

/** Encodes list conditions and grouping as the list API expects them. */
const conditions = (match, ...items) =>
  `where=${encodeURIComponent(JSON.stringify({ match, conditions: items }))}`;

it('filters, sorts and groups customers by catalog conditions without matching withheld details', async (t) => {
  const f = await settingsFixture(t);
  const c = await customersFixture(f);
  await f.db.owner.query(
    `UPDATE customer_profiles SET last_order_at=v.at FROM (VALUES ($1::uuid,'2026-10-01T08:00:00Z'::timestamptz),
      ($2::uuid,'2026-09-02T08:00:00Z'::timestamptz)) v(id,at) WHERE tenant_id=$3 AND customer_profiles.id=v.id`,
    [c.ids.avery, c.ids.jonas, f.org.id],
  );
  const list = (query) => f.request(f.member, `${f.base}/customers?${query}`);
  const matching = async (match, ...items) =>
    names(await list(conditions(match, ...items))).sort();

  expect(
    await matching('all', {
      field: 'state',
      op: 'any_of',
      value: ['enabled', 'invited'],
    }),
  ).toEqual(['Avery Tan', 'Avery Tan']);
  // A country the source does not share is unknown: it matches neither a value nor empty.
  expect(
    await matching('all', { field: 'country', op: 'is', value: 'japan' }),
  ).toEqual(['Avery Tan']);
  expect(await matching('all', { field: 'country', op: 'empty' })).toEqual([
    'Avery Tan',
    'Jonas Weber',
  ]);
  expect(
    await matching('all', { field: 'country', op: 'none_of', value: ['JP'] }),
  ).toEqual(['Avery Tan', 'Avery Tan', 'Jonas Weber']);
  expect(await matching('all', { field: 'country', op: 'unknown' })).toEqual([
    'gid://shopify/Customer/73',
  ]);
  // Unreported counts and amounts never match comparisons.
  expect(
    await matching('all', { field: 'orders', op: 'gte', value: 2 }),
  ).toEqual(['Avery Tan', 'Avery Tan']);
  expect(
    await matching('all', {
      field: 'spent',
      op: 'between',
      value: {
        from: { amount: '50', currency: 'EUR' },
        to: { amount: '500', currency: 'EUR' },
      },
    }),
  ).toEqual(['Avery Tan', 'Avery Tan']);
  expect(
    await matching('all', {
      field: 'spent',
      op: 'gt',
      value: { amount: '1', currency: 'USD' },
    }),
  ).toEqual([]);
  expect(
    await matching('all', { field: 'tags', op: 'none_of', value: ['VIP'] }),
  ).toEqual(['Avery Tan', 'Jonas Weber', 'gid://shopify/Customer/73']);
  expect(
    await matching('all', { field: 'contactShared', op: 'is', value: false }),
  ).toEqual(['gid://shopify/Customer/73']);
  expect(
    await matching('all', { field: 'missing', op: 'is', value: true }),
  ).toEqual([]);
  expect(
    await matching(
      'any',
      { field: 'lastOrder', op: 'after', value: '2026-09-15' },
      { field: 'state', op: 'any_of', value: ['invited'] },
    ),
  ).toEqual(['Avery Tan', 'Avery Tan']);
  const lastOrder = await list('sort=lastOrder&direction=asc');
  expect(lastOrder.items.map((item) => item.lastOrderAt)).toEqual([
    '2026-09-02T08:00:00.000Z',
    '2026-10-01T08:00:00.000Z',
    null,
    null,
  ]);

  // Groups count every match in catalog order; customers without a value come last.
  const byState = await list('group=state&groupLimit=1');
  expect(
    byState.groups.map((group) => [group.key, group.count, group.complete]),
  ).toEqual([
    ['enabled', 1, true],
    ['disabled', 1, true],
    ['invited', 1, true],
    ['unknown', 1, true],
  ]);
  expect(byState.items).toHaveLength(4);
  expect(byState.groupsTruncated).toBe(false);
  const byCountry = await list('group=country');
  expect(byCountry.groups.map((group) => [group.key, group.count])).toEqual([
    ['JAPAN', 1],
    [null, 3],
  ]);
  expect(byCountry.groups[0].sums).toEqual([
    { field: 'spent', currency: 'EUR', amount: '482.000000' },
  ]);
  // A group's page link continues within that group and only there.
  const bySource = await list(
    'group=source&groupLimit=1&sort=name&direction=asc',
  );
  const vienna = bySource.groups.find((group) => group.key === c.vienna);
  expect(vienna.count).toBe(2);
  const rest = await list(
    `group=source&groupKey=${encodeURIComponent(JSON.stringify(c.vienna))}&sort=name&direction=asc&limit=5&cursor=${vienna.nextCursor}`,
  );
  expect(names(rest)).toEqual(['Jonas Weber']);
  expect(rest.groups).toEqual([
    expect.objectContaining({ key: c.vienna, count: 2, nextCursor: null }),
  ]);
  await f.request(
    f.member,
    `${f.base}/customers?sort=name&direction=asc&cursor=${vienna.nextCursor}`,
    'GET',
    undefined,
    400,
  );

  for (const query of [
    conditions('all', { field: 'name', op: 'contains', value: 'Avery' }),
    conditions('all', { field: 'state', op: 'gt', value: 1 }),
    'group=name',
    'group=created',
    `groupKey=${encodeURIComponent('"enabled"')}`,
  ])
    await f.request(
      f.member,
      `${f.base}/customers?${query}`,
      'GET',
      undefined,
      400,
    );

  // Without orders access the last order date is hidden and can't be used.
  const created = await f.app.inject({
    method: 'POST',
    url: `${f.base}/roles`,
    headers: {
      origin: f.config.baseURL,
      cookie: f.owner.cookie,
      'x-command-id': randomUUID(),
    },
    payload: {
      name: 'Customers only',
      description: '',
      permissions: ['customers.read'],
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  await f.request(f.owner, `${f.base}/members/${f.membership.id}`, 'PATCH', {
    roleId: created.json().id,
  });
  const restricted = await list('');
  expect(restricted.items.every((item) => !('lastOrderAt' in item))).toBe(true);
  for (const query of [
    conditions('all', { field: 'lastOrder', op: 'empty' }),
    'group=lastOrder:month',
    'sort=lastOrder',
  ])
    await f.request(
      f.member,
      `${f.base}/customers?${query}`,
      'GET',
      undefined,
      403,
    );
});

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
