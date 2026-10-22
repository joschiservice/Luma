import { createHash, randomUUID } from 'node:crypto';

import { createConnectionCoverage } from '@luma/connections/composition';
import { createCaseMetricReader } from '@luma/exceptions/composition';
import { builtInMembership, makeTenantContext } from '@luma/identity';
import { createTenantDatabase } from '@luma/platform/composition';
import { createProcurementMetricReader } from '@luma/procurement/composition';
import { createOperationalSummary } from '@luma/read-models/composition';

/** Seeds compact cross-domain records with deterministic identities for metric reconciliation. */
export async function seedOperationalMetrics(f, count = 1) {
  const tenant = f.org.id;
  const connectionId = randomUUID();
  const supplierId = randomUUID();
  const now = new Date().toISOString();
  await f.db.owner.query(
    'INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,1,$3,$4)',
    [
      tenant,
      connectionId,
      {
        id: connectionId,
        tenantId: tenant,
        label: 'Warehouse',
        target: { kind: 'jtl' },
        status: 'active',
        permissions: ['inventory.read', 'orders.read'],
        granted: ['inventory.read', 'orders.read'],
        version: 1,
      },
      'fixture',
    ],
  );
  await f.request(f.owner, `${f.base}/procurement/suppliers`, 'POST', {
    id: supplierId,
    name: 'Northstar Supply',
  });
  const rows = [];
  const tx = await f.db.owner.connect();
  try {
    await tx.query('BEGIN');
    for (let i = 0; i < count; i++) {
      const id = randomUUID(),
        positionId = randomUUID(),
        skuId = randomUUID(),
        ruleId = randomUUID(),
        snapshotId = randomUUID(),
        observationId = randomUUID();
      const sku = `SKU-${i}`;
      const fingerprint = createHash('sha256').update(id).digest('hex');
      const incident = {
        id,
        tenantId: tenant,
        fingerprint,
        state: 'escalated',
        exceptionClass: 'workflow_failure',
        severity: 'high',
        subject: {
          subjectKind: 'workflow_run',
          subjectId: `run-${i}`,
          scope: [],
        },
        firstDetectedAt: now,
        lastDetectedAt: now,
        occurrenceCount: 1,
      };
      await tx.query(
        'INSERT INTO exceptions(id,tenant_id,fingerprint,state,document) VALUES($1,$2,$3,$4,$5)',
        [id, tenant, fingerprint, incident.state, incident],
      );
      await tx.query(
        "INSERT INTO inventory_entities(id,tenant_id,kind,reconciliation_key) VALUES($1,$2,'sku',$3),($4,$2,'position',$5)",
        [skuId, tenant, sku, positionId, `${sku}:warehouse`],
      );
      await tx.query(
        'INSERT INTO connector_observations(id,tenant_id,connection_id,ingest_key,document) VALUES($1,$2,$3,$4,$5)',
        [
          observationId,
          tenant,
          connectionId,
          observationId,
          {
            capability: 'inventory.read',
            observation: {
              id: observationId,
              observedAt: now,
              source: { tenantId: tenant, connectionId },
            },
          },
        ],
      );
      const document = {
        entityId: positionId,
        connectionId,
        observationId,
        kind: 'position',
        observedAt: now,
        deleted: false,
        data: { skuId, available: '5', unit: 'each' },
      };
      await tx.query(
        "INSERT INTO inventory_snapshots(id,tenant_id,entity_id,kind,connection_id,observation_id,normalizer_version,mapping_version,observed_at,document) VALUES($1,$2,$3,'position',$4,$5,'fixture','fixture',$6,$7)",
        [
          snapshotId,
          tenant,
          positionId,
          connectionId,
          observationId,
          now,
          document,
        ],
      );
      await tx.query(
        'INSERT INTO inventory_projections(tenant_id,entity_id,connection_id,snapshot_id) VALUES($1,$2,$3,$4)',
        [tenant, positionId, connectionId, snapshotId],
      );
      const rule = {
        id: ruleId,
        positionId,
        connectionId,
        supplierId,
        sku,
        supplier: 'Northstar Supply',
        minimum: 10,
        target: 20,
        approvalQuantity: 100,
        active: true,
        principalId: f.owner.id,
        reviewedAt: now,
        versionDigest: 'fixture',
        artifactDigest: 'fixture',
        policyVersion: 'fixture',
      };
      await tx.query(
        'INSERT INTO replenishment_activations(tenant_id,id,position_id,principal_id,document,created_at) VALUES($1,$2,$3,$4,$5,$6)',
        [tenant, ruleId, positionId, f.owner.id, rule, now],
      );
      rows.push({ id, positionId, skuId, ruleId, snapshotId, sku });
    }
    await tx.query('COMMIT');
  } finally {
    tx.release();
  }
  const createOrder = async (sku = rows[0].sku) => {
    const input = {
      id: randomUUID(),
      supplierId,
      reference: `PO-${sku}`,
      lines: [
        {
          id: randomUUID(),
          sku,
          description: 'Replenishment',
          quantity: 2,
          unit: 'each',
        },
        {
          id: randomUUID(),
          sku,
          description: 'Additional stock',
          quantity: 1,
          unit: 'each',
        },
      ],
    };
    const order = await f.request(
      f.owner,
      `${f.base}/procurement/purchase-orders`,
      'POST',
      input,
    );

    return { order, input };
  };

  return { connectionId, supplierId, rows, createOrder };
}

export const operationalRequest = {
  definitionVersion: 2,
  metrics: [
    'cases.active',
    'cases.attention',
    'cases.oldest_unresolved_age',
    'inventory.below_minimum',
    'inventory.replenishment_unknown',
    'procurement.purchase_orders.draft',
    'procurement.purchase_orders.open',
    'connections.needing_attention',
  ],
};

export const operationalEndpoint = (f) =>
  `/v2/organizations/${f.org.id}/metrics/query`;

/**
 * Runs the cross-domain operational summary once as the workspace owner and returns the SELECT
 * and WITH statements it sent. With `explain`, each statement also records its
 * `EXPLAIN (ANALYZE, BUFFERS)` plan, which executes the statement a second time.
 */
export async function summaryStatements(f, { explain = false } = {}) {
  const statements = [];
  const db = createTenantDatabase(f.db.owner);
  const recorded = {
    transaction: (tenant, operation, options) =>
      db.transaction(
        tenant,
        (tx) =>
          operation({
            query: async (sql, values) => {
              if (/^\s*(SELECT|WITH)/i.test(sql))
                statements.push({
                  sql,
                  ...(explain && {
                    plan: (
                      await tx.query(
                        `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`,
                        values,
                      )
                    ).rows[0]['QUERY PLAN'],
                  }),
                });

              return tx.query(sql, values);
            },
          }),
        options,
      ),
  };
  const actor = makeTenantContext(
    { userId: f.owner.id, sessionId: 'fixture' },
    { ...f.org, status: 'active', dataRegion: 'AU' },
    builtInMembership(
      { id: randomUUID(), organizationId: f.org.id, userId: f.owner.id },
      'owner',
    ),
    randomUUID(),
  );
  await createOperationalSummary(recorded, {
    cases: createCaseMetricReader,
    procurement: createProcurementMetricReader,
    coverage: createConnectionCoverage,
  })(actor, operationalRequest);

  return statements;
}
