import { randomUUID } from 'node:crypto';

import { compilePlaybook } from '../dist/modules/workflows/composition.js';
import { shippingMethodPlaybook } from '../dist/modules/workflows/index.js';

/** Seeds published source data and mapped orders; activations must go through the real API. */
export async function seedPlaybooks(db, tenantId) {
  const connectionId = randomUUID(),
    targetId = randomUUID(),
    observationId = randomUUID();
  const version = compilePlaybook(shippingMethodPlaybook);
  await db.owner.query(
    'INSERT INTO playbook_definitions(tenant_id,id,document) VALUES($1,$2,$3)',
    [tenantId, version.definition.id, version.definition],
  );
  await db.owner.query(
    'INSERT INTO playbook_versions(tenant_id,definition_id,version,digest,document) VALUES($1,$2,$3,$4,$5)',
    [tenantId, version.definition.id, version.version, version.digest, version],
  );
  const connection = {
    id: connectionId,
    tenantId,
    label: 'JTL warehouse',
    target: { kind: 'jtl-cloud', jtlTenantId: randomUUID() },
    permissions: ['orders.read', 'orders.shipping-method.write'],
    granted: ['orders.read', 'orders.shipping-method.write'],
    status: 'active',
    version: 2,
    credentialVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await db.owner.query(
    'INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,2,$3,$4)',
    [tenantId, connectionId, connection, 'encrypted-fixture'],
  );
  await db.owner.query(
    'INSERT INTO connector_observations(id,tenant_id,connection_id,ingest_key,document) VALUES($1,$2,$3,$4,$5)',
    [
      observationId,
      tenantId,
      connectionId,
      'fixture',
      { observation: { source: { tenantId, connectionId } } },
    ],
  );
  await db.owner.query(
    `INSERT INTO connector_source_mappings(id,tenant_id,connection_id,resource,scope_key,external_id,canonical_id,observation_id,method,actor_id) VALUES($1,$2,$3,'order','orders','Order 1042',$4,$5,'fixture','fixture')`,
    [randomUUID(), tenantId, connectionId, targetId, observationId],
  );

  return { connectionId, targetId, version };
}
