import { createCommerceSyncWorker } from '@luma/application-runtime/sync';
import { readConnectionsConfig, readIdentityConfig } from '@luma/config';
import { createSimulationTransport } from '@luma/connections/composition';
import { createIdentity } from '@luma/identity/composition';
import { createTenantDatabase } from '@luma/platform/composition';
import { Pool } from 'pg';

import { simulatorShopifyEnv } from '../../../tooling/simulator/shopify-app.mjs';

process.once('message', async ({ env, manifest }) => {
  const settings = {
    ...env,
    ...simulatorShopifyEnv(manifest.simulator.webhookSecret),
    SHOPIFY_ADMISSION_URL: process.env.SHOPIFY_ADMISSION_URL,
  };
  const identity = createIdentity(readIdentityConfig(settings));
  const pool = new Pool({
    connectionString: settings.WORKFLOW_DATABASE_URL,
    max: 12,
  });
  const worker = createCommerceSyncWorker({
    database: createTenantDatabase(pool),
    identity: identity.service,
    connections: readConnectionsConfig(settings),
    env: settings,
    simulation: createSimulationTransport(manifest.simulator),
    concurrency: 1,
    workspaceConcurrency: 4,
    connectionConcurrency: 2,
    idleMs: 100,
    log: (message, error) =>
      console.error(message, error instanceof Error ? error.message : error),
  });
  process.on('message', (message) => {
    if (message === 'stop') worker.shutdown();
  });
  process.send({ type: 'running' });
  try {
    await worker.run();
  } finally {
    await worker.close();
    await identity.close();
    await pool.end();
  }
  process.send({ type: 'stopped' });
  process.disconnect();
});
process.send({ type: 'ready' });
