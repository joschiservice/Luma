import { writeFile } from 'node:fs/promises';

import { createSimulationTransport } from '@luma/connections/composition';
import { createIdentity } from '@luma/identity/composition';
import { createTenantDatabase } from '@luma/platform/composition';
import { Pool } from 'pg';

import {
  createInstallationVerifier,
  createInstalledConnections,
} from '../apps/providers.mjs';
import { syntheticFeatureRelease } from './feature-release.mjs';
import { identitySettings } from './settings.mjs';

/** Adds the shipping connection to an existing synthetic workspace without recreating its data. */
export async function ensureShippingInstallation(
  env,
  manifest,
  path,
  simulator,
) {
  const shipping = simulator?.instances.find(
    (instance) => instance.kind === 'starshipit',
  );
  if (!shipping || manifest.connections[shipping.name]) return manifest;
  const featureEnabled = syntheticFeatureRelease(env);
  if (
    !(await featureEnabled(manifest.organizationId, 'starshipit-fulfillment'))
  )
    return manifest;
  const identity = createIdentity(identitySettings(env), {
    onDatabaseError: (error) =>
      console.error('Identity database connection failed', error),
  });
  const pool = new Pool({ connectionString: env.WORKFLOW_DATABASE_URL });
  let connections;
  try {
    connections = createInstalledConnections(createTenantDatabase(pool), {
      featureEnabled,
      refreshContext: identity.service.refreshContext,
      activeKeyId: env.CONNECTIONS_ACTIVE_KEY_ID,
      keys: new Map(
        Object.entries(JSON.parse(env.CONNECTIONS_KEYS)).map(([id, value]) => [
          id,
          Buffer.from(value, 'base64'),
        ]),
      ),
      verify: (connection, credentials) =>
        createInstallationVerifier({
          featureEnabled,
          simulation: createSimulationTransport(manifest.simulator),
        })(connection, credentials),
    });
    const actor = await identity.service.resolveWorkflowContext(
      manifest.requesterId,
      manifest.organizationId,
      'synthetic-shipping-upgrade',
    );
    const apps = await connections.apps.list(actor);
    const app = apps.catalog.find((item) => item.id === 'starshipit');
    if (!app) return manifest;
    const state = apps.installations.find((item) => item.appId === app.id);
    if (state?.status !== 'installed')
      await connections.apps.install(
        actor,
        app.id,
        state?.version ?? null,
        app.scopes,
      );
    const target = {
      kind: 'starshipit',
      accountId: 'luma-synthetic-starshipit',
    };
    const connection = await connections.install(actor, {
      label: 'SIMULATED STARSHIPIT · no live health',
      target,
      permissions: [
        'orders.read',
        'fulfillment.read',
        ...((await featureEnabled(
          manifest.organizationId,
          'starshipit-actions',
        ))
          ? ['orders.quantity.update']
          : []),
      ],
      credentials: {
        token: 'synthetic-not-a-provider-secret',
        subscriptionKey: 'synthetic-subscription-key',
        webhookSecret: manifest.simulator.webhookSecret,
      },
    });
    manifest.connections[shipping.name] = connection.id;
    manifest.simulator.instances.push(shipping);
    manifest.simulator.bindings.push({
      tenantId: manifest.organizationId,
      connectionId: connection.id,
      target,
      runId: manifest.simulator.runId,
      instance: shipping.name,
      provider: 'starshipit',
    });
    await connections.check(actor, connection.id, connection.version);
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });

    return manifest;
  } finally {
    await connections?.close();
    await identity.close();
    await pool.end();
  }
}
