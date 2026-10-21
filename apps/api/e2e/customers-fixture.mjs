import { randomUUID } from 'node:crypto';

/**
 * Adds a Shopify store that shares customers, a second store and a JTL connection that does not,
 * and stores imported profiles as the customers owner does after a sync.
 */
export async function customersFixture(f) {
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
