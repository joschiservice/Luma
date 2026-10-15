import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { createAppHost } from '@luma/app-catalog';
import { createDetectionServices } from '@luma/application-runtime';
import { defaultConfiguration } from '@luma/exceptions';
import { createTenantDatabase } from '@luma/platform/composition';
import { Pool } from 'pg';

import {
  correctionFixture,
  stockLocation,
} from './shopify-inventory-fixture.mjs';

/** Creates a stalled pair using real policy, execution and simulator services. */
export async function protectionFixture(t, mode = 'on', origin, options) {
  const f = await correctionFixture(t, origin, options);
  await f.f.db.owner.query(
    `GRANT luma_exceptions TO "${new URL(f.f.db.runtimeUrl).username}"`,
  );
  const pool = new Pool({ connectionString: f.f.db.runtimeUrl });
  t.onTestFinished(() => pool.end());
  const database = createTenantDatabase(pool);
  const actor = await f.f.identity.service.resolveWorkflowContext(
    f.f.owner.id,
    f.f.org.id,
    'stock-protection-journey',
  );
  let authority = 9;
  let readFails = false;
  const host = createAppHost(database, {
    ...f.connectionsConfig,
    env: {},
    refreshContext: f.f.identity.service.refreshContext,
    featureEnabled: async (_tenant, flag) => flag === 'stock-protection',
    refreshStock: async () =>
      readFails
        ? undefined
        : f.stock
            .stock({
              connectionId: f.stock.erp,
              external: '77',
              location: stockLocation,
              amount: String(authority),
            })
            .then(() => undefined),
  });
  t.onTestFinished(() => host.close());
  const service = host.registry.stockProtection()[0];
  // Contract inputs name only the store pair; arbitrary target quantities never enter protection.
  const policy = {
    connectionId: f.target.connectionId,
    sourceConnectionId: f.target.sourceConnectionId,
    mode,
    riskThreshold: 15,
  };
  await service.save(actor, { settings: policy });
  for (const connectionId of [
    f.target.connectionId,
    f.target.sourceConnectionId,
  ])
    await f.f.db.owner.query(
      `INSERT INTO commerce_sync_streams(tenant_id,id,connection_id,record_type,principal_id,phase,last_complete_at) VALUES($1,$2,$3,'inventory',$4,'incremental',now()) ON CONFLICT(tenant_id,connection_id,record_type) DO UPDATE SET last_complete_at=now(),error_at=NULL`,
      [actor.tenantId, randomUUID(), connectionId, actor.actor.id],
    );
  const detection = createDetectionServices(database);
  t.onTestFinished(() => detection.close());
  const corpus = JSON.parse(
    await readFile(
      new URL(
        '../../../packages/exceptions/fixtures/exceptions-v0.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const at = new Date().toISOString(),
    keys = [randomUUID(), randomUUID()];
  const result = await detection.exceptions.ingest(actor, {
    key: randomUUID(),
    configuration: defaultConfiguration,
    input: {
      exceptionClass: 'stock_sync_stall',
      facts: {
        ...corpus.bases.stock_sync_stall,
        tenantId: actor.tenantId,
        evidenceTenantId: actor.tenantId,
        subjectId: f.target.connectionId,
        connectionIds: [f.target.sourceConnectionId, f.target.connectionId],
        evidenceRefs: keys,
        oldestReadAt: at,
        latestReadAt: at,
        laggingSince: new Date(Date.now() - 1800000).toISOString(),
      },
    },
    evidence: keys.map((key, index) => ({
      key,
      tenantId: actor.tenantId,
      connectionId: index ? f.target.connectionId : f.target.sourceConnectionId,
      observedAt: at,
      sourceUpdatedAt: null,
      adapterVersion: 'journey/1',
      schemaVersion: 1,
      source: null,
      facts: { stock: true },
    })),
  });
  const incidentId = result.incident.id;
  await service.discover(actor);

  return {
    ...f,
    actor,
    service,
    host,
    database,
    incidentId,
    setAuthority: (value) => {
      authority = value;
    },
    setReadFailure: (value) => {
      readFails = value;
    },
    view: async () =>
      (await service.view(actor, { incidentId, limit: 200 })).incidents.find(
        (i) => i.id === incidentId,
      ),
    recreate: () =>
      createAppHost(database, {
        ...f.connectionsConfig,
        env: {},
        refreshContext: f.f.identity.service.refreshContext,
        featureEnabled: async () => true,
        refreshStock: async () =>
          f.stock
            .stock({
              connectionId: f.stock.erp,
              external: '77',
              location: stockLocation,
              amount: String(authority),
            })
            .then(() => undefined),
      }),
  };
}
