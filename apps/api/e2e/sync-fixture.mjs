import { randomBytes, randomUUID } from 'node:crypto';

import { settingsFixture } from './settings-fixture.mjs';

const reads = [
  'orders.read',
  'fulfillment.read',
  'products.read',
  'inventory.read',
];

/**
 * Seeds a Shopify connection with an importing order stream, a JTL connection and two SKUs
 * that share a code, on a runtime app with connection storage configured.
 */
export async function syncFixture(t, origin = 'http://localhost:3000') {
  const f = await settingsFixture(t, origin, {
    connections: {
      activeKeyId: 'test',
      keys: new Map([['test', randomBytes(32)]]),
    },
  });
  const role = new URL(f.db.runtimeUrl).username;
  await f.db.owner.query(
    `GRANT luma_connectors,luma_commerce_sync TO "${role}"`,
  );
  const store = randomUUID();
  const erp = randomUUID();
  for (const [id, label, provider] of [
    [store, 'Tokyo store', 'shopify'],
    [erp, 'JTL-Wawi', 'jtl'],
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
          provider,
          appInstallationVersion: 1,
          target:
            provider === 'shopify'
              ? { kind: 'shopify', shop: 'tokyo.myshopify.com' }
              : { kind: 'jtl-cloud', jtlTenantId: randomUUID() },
          label,
          permissions: reads,
          granted: reads,
          credentialVersion: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        'fixture',
      ],
    );
  }
  const stream = randomUUID();
  await f.db.owner.query(
    `INSERT INTO commerce_sync_streams(tenant_id,id,connection_id,record_type,principal_id,phase,scan,scan_id,
      scan_started_at,scan_pages,scan_records,scan_total,due_at,history_from,history_requirement,current_history_limited)
    VALUES($1,$2,$3,'orders',$4,'backfill','backfill',$5,now(),2,50,120,now(),now()-interval '60 days','read_all_orders',true)`,
    [f.org.id, stream, store, f.owner.id, randomUUID()],
  );
  await f.db.owner.query(
    `INSERT INTO commerce_sync_items(tenant_id,connection_id,record_type,resource,scope_key,external_id,digest,status,
      source_created_at,first_seen_at,last_seen_at,changed_at,first_seen_by)
    SELECT $1,$2,'orders','order','',n::text,'d','current',now()-n*interval '1 day',now(),now(),now(),'backfill'
    FROM generate_series(1,50) n`,
    [f.org.id, store],
  );
  const skus = {};
  for (const [connectionId, external] of [
    [store, 'gid://shopify/InventoryItem/1'],
    [erp, '77'],
  ]) {
    const observation = randomUUID();
    await f.db.owner.query(
      'INSERT INTO connector_observations(id,tenant_id,connection_id,ingest_key,document) VALUES($1,$2,$3,$4,$5)',
      [
        observation,
        f.org.id,
        connectionId,
        observation,
        {
          capability: 'products.read',
          observation: {
            id: observation,
            source: {
              tenantId: f.org.id,
              connectionId,
              provider: 'fixture',
              resource: 'product',
              externalId: `product-${external}`,
              scopeKey: '',
            },
          },
        },
      ],
    );
    const sku = randomUUID();
    const product = randomUUID();
    skus[connectionId] = sku;
    await f.db.owner.query(
      "INSERT INTO inventory_entities(id,tenant_id,kind,reconciliation_key) VALUES($1,$2,'sku',$3),($4,$2,'product',$5)",
      [
        sku,
        f.org.id,
        JSON.stringify(['source', connectionId, 'sku', '', external]),
        product,
        `product-${external}`,
      ],
    );
    await f.db.owner.query(
      `INSERT INTO connector_source_mappings(id,tenant_id,connection_id,resource,scope_key,external_id,canonical_id,observation_id,method,actor_id)
      VALUES($1,$2,$3,'sku','',$4,$5,$6,'Imported source record','fixture')`,
      [randomUUID(), f.org.id, connectionId, external, sku, observation],
    );
    const snapshot = randomUUID();
    await f.db.owner.query(
      `INSERT INTO inventory_snapshots(id,tenant_id,entity_id,kind,connection_id,observation_id,normalizer_version,mapping_version,observed_at,document)
      VALUES($1,$2,$3,'product',$4,$5,'commerce/1',$6,now(),$7)`,
      [
        snapshot,
        f.org.id,
        product,
        connectionId,
        observation,
        'a'.repeat(64),
        {
          entityId: product,
          connectionId,
          observationId: observation,
          kind: 'product',
          data: {
            type: 'product',
            title: 'Linen shirt',
            status: 'active',
            skus: [{ skuId: sku, code: 'LINEN-M', unit: 'each' }],
          },
        },
      ],
    );
    await f.db.owner.query(
      'INSERT INTO inventory_projections(tenant_id,entity_id,connection_id,snapshot_id) VALUES($1,$2,$3,$4)',
      [f.org.id, product, connectionId, snapshot],
    );
    await f.db.owner.query(
      `INSERT INTO inventory_product_skus(tenant_id,product_id,connection_id,sku_id,code,snapshot_id,
        product_title,product_status,unit,observed_at) VALUES($1,$2,$3,$4,'LINEN-M',$5,'Linen shirt','active','each',now())`,
      [f.org.id, product, connectionId, sku, snapshot],
    );
  }

  return { ...f, store, erp, stream, skus };
}
