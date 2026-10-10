import { randomUUID } from 'node:crypto';

import { createCommerceServices } from '@luma/application-runtime';
import { createCommerceSyncWorker } from '@luma/application-runtime/sync';
import { builtInMembership, makeTenantContext } from '@luma/identity';
import { createOrderListRebuilder } from '@luma/orders/composition';
import { createTenantDatabase } from '@luma/platform/composition';

/**
 * Creates a Shopify store and an ERP connection, then returns helpers that ingest mapped orders
 * through the commerce services and bulk-import historical orders for paging.
 */
export async function ordersFixture(t, f) {
  const context = makeTenantContext(
    { userId: f.owner.id, sessionId: 'fixture' },
    { ...f.org, status: 'active', dataRegion: 'EU' },
    builtInMembership(
      { id: randomUUID(), organizationId: f.org.id, userId: f.owner.id },
      'owner',
    ),
    randomUUID(),
  );
  const store = randomUUID();
  const erp = randomUUID();
  for (const [id, kind, label] of [
    [store, 'shopify', 'Tokyo store'],
    [erp, 'jtl', 'JTL-Wawi'],
  ])
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
          provider: kind,
          target: { kind },
          label,
          permissions: ['orders.read', 'fulfillment.read'],
          granted: ['orders.read', 'fulfillment.read'],
        },
        'fixture',
      ],
    );
  const commerce = createCommerceServices(f.db.ownerUrl);
  t.onTestFinished(() => commerce.close());

  /** Ingests one order with its lines and binds the order, lines and SKUs by explicit keys. */
  async function order({
    connectionId = store,
    external,
    key,
    updatedAt = new Date().toISOString(),
    data,
    lines,
    imported = false,
  }) {
    const source = {
      tenantId: f.org.id,
      connectionId,
      provider: connectionId === erp ? 'jtl' : 'shopify',
      resource: 'order',
      externalId: external,
      scopeKey: '',
    };
    const observation = {
      capability: 'orders.read',
      observation: {
        id: randomUUID(),
        source,
        kind: 'snapshot',
        observedAt: updatedAt,
        sourceUpdatedAt: updatedAt,
        sourceRevision: null,
        adapterVersion: 'fixture/1',
        schemaVersion: 1,
        data: {
          displayNumber: null,
          status: 'open',
          paymentStatus: 'paid',
          ...data,
          lines: lines.map((line) => ({
            id: { externalId: line.external, scopeKey: external },
            sku: line.sku ? { externalId: line.sku, scopeKey: '' } : null,
            quantity: { amount: line.quantity, unit: 'each' },
            ...(line.currentQuantity === undefined
              ? {}
              : {
                  currentQuantity: {
                    amount: line.currentQuantity,
                    unit: 'each',
                  },
                }),
            cancelledQuantity: {
              amount: line.cancelledQuantity ?? '0',
              unit: 'each',
            },
            skuCode: line.skuCode ?? null,
            title: line.title ?? null,
          })),
        },
      },
    };
    const ingestKey = observation.observation.id;
    if (imported) {
      const outcome = await commerce.ingestion.import(
        context,
        ingestKey,
        observation,
      );
      if (outcome.status === 'pending')
        throw new Error('Fixture order import is pending');

      return outcome.entityId;
    }
    await commerce.ingestion.ingest(context, ingestKey, observation);
    const id = await commerce.ingestion.bind(
      context,
      source,
      key,
      observation.observation.id,
      'operator-confirmed',
    );
    for (const line of lines) {
      await commerce.ingestion.bind(
        context,
        {
          ...source,
          resource: 'order_line',
          externalId: line.external,
          scopeKey: external,
        },
        `${key}:${line.external}`,
        observation.observation.id,
        'operator-confirmed',
      );
      if (line.sku)
        await commerce.ingestion.bind(
          context,
          { ...source, resource: 'sku', externalId: line.sku, scopeKey: '' },
          line.skuKey ?? line.sku,
          observation.observation.id,
          'operator-confirmed',
        );
    }
    await commerce.ingestion.replay(context, connectionId, ingestKey);

    return id;
  }

  /** Copies a seeded order snapshot into `count` historical orders on the store connection. */
  async function importHistory(templateOrderId, count) {
    await f.db.owner.query(
      `WITH template AS (
        SELECT s.document,s.observation_id,s.mapping_version FROM orders_projections p
        JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
        WHERE p.tenant_id=$1 AND p.entity_id=$2 AND p.connection_id=$3
      ), entities AS (
        INSERT INTO orders_entities(id,tenant_id,kind,reconciliation_key)
        SELECT gen_random_uuid(),$1,'order','history-' || n FROM generate_series(1,$4::int) n
        RETURNING id,substr(reconciliation_key,9)::int AS n
      ), snapshots AS (
        INSERT INTO orders_snapshots(id,tenant_id,entity_id,kind,connection_id,observation_id,normalizer_version,mapping_version,source_updated_at,observed_at,document)
        SELECT gen_random_uuid(),$1,e.id,'order',$3,t.observation_id,'import/1',t.mapping_version,
          timestamptz '2025-01-01' + e.n * interval '1 day',now(),
          jsonb_set(jsonb_set(jsonb_set(jsonb_set(t.document,'{entityId}',to_jsonb(e.id::text)),
            '{sourceUpdatedAt}',to_jsonb(to_char((timestamptz '2025-01-01' + e.n * interval '1 day') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))),
            '{data,displayNumber}',to_jsonb('#' || (3000 + e.n))),
            '{data,placedAt}',to_jsonb(to_char((timestamptz '2025-01-01' + e.n * interval '1 day') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')))
        FROM entities e CROSS JOIN template t RETURNING entity_id,id
      ) INSERT INTO orders_projections(tenant_id,entity_id,connection_id,snapshot_id)
        SELECT $1,entity_id,$3,id FROM snapshots`,
      [f.org.id, templateOrderId, store, count],
    );
    const rebuild = createOrderListRebuilder(createTenantDatabase(f.db.owner));
    let after;
    do {
      after = await rebuild(context, after ?? undefined);
    } while (after);
  }

  const worker = createCommerceSyncWorker({
    database: createTenantDatabase(f.db.owner),
    identity: f.identity.service,
    connections: {
      activeKeyId: 'fixture',
      keys: new Map([['fixture', new Uint8Array(32)]]),
    },
  });
  t.onTestFinished(() => worker.close());

  return {
    store,
    erp,
    order,
    importHistory,
    applyLinks: () => worker.runner.tick(f.org.id),
  };
}
