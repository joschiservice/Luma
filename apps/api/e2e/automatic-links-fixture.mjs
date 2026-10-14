import { randomUUID } from 'node:crypto';

import { createCommerceServices } from '@luma/application-runtime';
import { createAutomaticLinkStore } from '@luma/application-runtime/sync';
import { builtInMembership, makeTenantContext } from '@luma/identity';
import { createTenantDatabase } from '@luma/platform/composition';
import { Pool } from 'pg';

import { syncFixture } from './sync-fixture.mjs';

/** Adds complete catalog coverage and a real source-local SKU pair to the sync fixture. */
export async function automaticLinksFixture(t, origin) {
  const f = await syncFixture(t, origin);
  const pool = new Pool({ connectionString: f.db.runtimeUrl });
  const role = new URL(f.db.runtimeUrl).username;
  await f.db.owner.query(`GRANT luma_inventory,luma_orders TO "${role}"`);
  const commerce = createCommerceServices(createTenantDatabase(pool));
  t.onTestFinished(async () => {
    await commerce.close();
    await pool.end();
  });
  const context = makeTenantContext(
    { userId: f.owner.id, sessionId: 'fixture' },
    {
      ...f.org,
      status: 'active',
      dataRegion: globalThis.process.env.LUMA_REGION ?? 'AU',
    },
    builtInMembership(
      { id: randomUUID(), organizationId: f.org.id, userId: f.owner.id },
      'owner',
    ),
    randomUUID(),
  );
  for (const connectionId of [f.store, f.erp]) {
    const id = randomUUID();
    const result = await commerce.ingestion.import(context, id, {
      capability: 'products.read',
      observation: {
        id,
        source: {
          tenantId: f.org.id,
          connectionId,
          provider: connectionId === f.store ? 'shopify' : 'jtl',
          resource: 'product',
          externalId: 'auto-product',
          scopeKey: '',
        },
        kind: 'snapshot',
        observedAt: new Date().toISOString(),
        sourceUpdatedAt: null,
        sourceRevision: null,
        adapterVersion: 'fixture/1',
        schemaVersion: 1,
        data: {
          title: 'Automatic mug',
          status: 'active',
          skus: [
            {
              id: { externalId: 'auto-sku', scopeKey: '' },
              code: 'AUTO-1',
              unit: 'each',
            },
          ],
        },
      },
    });
    await f.db.owner.query(
      `INSERT INTO commerce_sync_streams(tenant_id,id,connection_id,record_type,principal_id,phase,last_full_scan_at,last_success_at,due_at)
      VALUES($1,$2,$3,'products',$4,'incremental',now(),now(),now()+interval '1 day')`,
      [f.org.id, randomUUID(), connectionId, f.owner.id],
    );
    await f.db.owner.query(
      `INSERT INTO commerce_sync_items(tenant_id,connection_id,record_type,resource,scope_key,external_id,digest,status,entity_id,first_seen_at,last_seen_at,changed_at,first_seen_by)
      VALUES($1,$2,'products','product','','auto-product','fixture','current',$3,now(),now(),now(),'backfill')`,
      [f.org.id, connectionId, result.entityId],
    );
  }

  return {
    ...f,
    automaticLinks: createAutomaticLinkStore(createTenantDatabase(pool)),
    context,
  };
}
