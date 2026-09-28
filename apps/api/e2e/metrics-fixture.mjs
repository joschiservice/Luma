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
