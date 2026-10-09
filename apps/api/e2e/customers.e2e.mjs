import { randomUUID } from 'node:crypto';

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
  expect(
    names(
      await f.request(f.member, `${f.base}/customers?sort=name&direction=asc`),
    ),
  ).toEqual([
    'gid://shopify/Customer/73',
    'Avery Tan',
    'Avery Tan',
    'Jonas Weber',
  ]);

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
