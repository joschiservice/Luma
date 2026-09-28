import { randomUUID } from 'node:crypto';

import { createCommerceServices } from '@luma/application-runtime';
import { makeTenantContext } from '@luma/identity';

/** Seeds mapped order observations through the commerce services for metric browser coverage. */
export async function seedMetricOrders(t, f) {
  const connection = randomUUID();
  const context = makeTenantContext(
    { userId: f.owner.id, sessionId: 'fixture' },
    { ...f.org, status: 'active', dataRegion: 'EU' },
    {
      id: randomUUID(),
      organizationId: f.org.id,
      userId: f.owner.id,
      role: 'owner',
    },
    randomUUID(),
  );
  await f.db.owner.query(
    'INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,1,$3,$4)',
    [
      f.org.id,
      connection,
      {
        id: connection,
        tenantId: f.org.id,
        version: 1,
        status: 'active',
        target: { kind: 'shopify' },
        label: 'Metric fixture',
        permissions: ['orders.read'],
        granted: ['orders.read'],
      },
      'fixture',
    ],
  );
  const commerce = createCommerceServices(f.db.ownerUrl);
  t.onTestFinished(() => commerce.close());

  return async (number) => {
    const externalId = `order-${number}`;
    const observedAt = new Date().toISOString();
    const source = {
      tenantId: f.org.id,
      connectionId: connection,
      provider: 'shopify',
      resource: 'order',
      externalId,
      scopeKey: '',
    };
    const observation = {
      capability: 'orders.read',
      observation: {
        id: randomUUID(),
        source,
        kind: 'snapshot',
        observedAt,
        sourceUpdatedAt: observedAt,
        sourceRevision: null,
        adapterVersion: 'fixture/1',
        schemaVersion: 1,
        data: {
          displayNumber: `#${1000 + number}`,
          status: 'open',
          paymentStatus: 'paid',
          dueAt: '2026-01-01T00:00:00Z',
          lines: [
            {
              id: { externalId: 'line', scopeKey: externalId },
              sku: null,
              quantity: { amount: '3', unit: 'each' },
              cancelledQuantity: { amount: '0', unit: 'each' },
            },
          ],
        },
      },
    };
    await commerce.ingestion.ingest(context, externalId, observation);
    await commerce.ingestion.bind(
      context,
      source,
      externalId,
      observation.observation.id,
      'manual',
    );
    await commerce.ingestion.bind(
      context,
      {
        ...source,
        resource: 'order_line',
        externalId: 'line',
        scopeKey: externalId,
      },
      `${externalId}-line`,
      observation.observation.id,
      'manual',
    );
    await commerce.ingestion.replay(context, connection, externalId);
  };
}

/** Adds a completed canonical fulfillment for an existing fixture order in one transaction. */
export async function seedMetricFulfillment(f, orderSnapshotId) {
  const tx = await f.db.owner.connect();
  const id = randomUUID();
  const snapshotId = randomUUID();
  try {
    await tx.query('BEGIN');
    const {
      rows: [order],
    } = await tx.query('SELECT * FROM orders_snapshots WHERE id=$1', [
      orderSnapshotId,
    ]);
    await tx.query(
      "INSERT INTO orders_entities(id,tenant_id,kind,reconciliation_key) VALUES($1,$2,'fulfillment',$3)",
      [id, f.org.id, id],
    );
    const observedAt = new Date().toISOString();
    const document = {
      ...order.document,
      entityId: id,
      kind: 'fulfillment',
      observedAt,
      sourceUpdatedAt: observedAt,
      deleted: false,
      data: {
        orderId: order.entity_id,
        status: 'completed',
        lines: order.document.data.lines.map((line) => ({
          orderLineId: line.id,
          quantity: line.quantity,
        })),
      },
    };
    await tx.query(
      "INSERT INTO orders_snapshots(id,tenant_id,entity_id,kind,connection_id,observation_id,normalizer_version,mapping_version,source_updated_at,observed_at,document) VALUES($1,$2,$3,'fulfillment',$4,$5,'fixture','fixture',$6,$6,$7)",
      [
        snapshotId,
        f.org.id,
        id,
        order.connection_id,
        order.observation_id,
        observedAt,
        document,
      ],
    );
    await tx.query(
      'INSERT INTO orders_projections(tenant_id,entity_id,connection_id,snapshot_id) VALUES($1,$2,$3,$4)',
      [f.org.id, id, order.connection_id, snapshotId],
    );
    await tx.query('COMMIT');

    return { id, snapshotId };
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
}
