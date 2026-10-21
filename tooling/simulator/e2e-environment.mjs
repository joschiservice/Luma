import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createApp } from '../../apps/simulator/dist/app.js';
import { createPilot } from '../pilot/runtime.mjs';
import { seedPilot } from '../pilot/seed.mjs';
import {
  registerWebhooks,
  simulatorInstances,
  waitForRun,
} from './connect.mjs';
import { testSimulatorDatabase } from './database.mjs';
import { createOperationsClient } from './platform-client.mjs';

/**
 * Starts an isolated healthy Luma workspace and simulator using the same provisioning, HTTP
 * bridge and sync runner as the local stack. The run uses the deterministic `test` profile on
 * the profile's ERP with `calm` failures unless options choose otherwise; its clock only moves
 * when tests advance it. `observability` evaluates workspace releases such as Luma orders.
 *
 * `databaseUrl` serves an existing simulator database instead of a disposable one for `t`.
 * With `manifest`, that database already holds the ready `operations` run and Luma's database
 * the seeded workspace the manifest describes, for example copies of an imported scenario: the
 * run and workspace are reused instead of created, and the manifest is pointed at this host.
 */
export async function createSimulatorEnvironment({
  t,
  directory,
  env,
  saved,
  temporal = null,
  profile = 'test',
  erp,
  historyDays,
  chaos = 'calm',
  detection,
  demo,
  observability,
  modelGateway,
  supplierExtraction,
  databaseUrl: existingDatabaseUrl,
  manifest: existingManifest,
}) {
  env = {
    FEATURE_FLAG_OVERRIDES:
      'starshipit-fulfillment=true,starshipit-actions=true,shopify-shipment-publishing=true',
    ...env,
  };
  const token = 'operational-simulator-test-token';
  const databaseUrl = existingDatabaseUrl ?? (await testSimulatorDatabase(t));
  let client;
  const simulator = await createApp({
    databaseUrl,
    token,
    autonomous: false,
    operations: (runId, action) => client.operations(runId, action),
    luma: (runId) => client.cases(runId),
  });
  let pilot;
  try {
    const simulatorOrigin = await simulator.listen({
      host: '127.0.0.1',
      port: 0,
    });
    const call = async (path, body, method) => {
      const response = await fetch(`${simulatorOrigin}/api/${path}`, {
        method: method ?? (body ? 'POST' : 'GET'),
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = response.status === 204 ? null : await response.json();
      if (!response.ok)
        throw new Error(`${response.status}: ${JSON.stringify(result)}`);

      return result;
    };
    if (!existingManifest)
      await call('runs', {
        id: 'operations',
        profile,
        ...(erp ? { erp } : {}),
        ...(historyDays === undefined ? {} : { historyDays }),
        chaos,
        seed: 44,
        running: false,
      });
    const run = await waitForRun(call, 'operations');
    const manifest = existingManifest
      ? await useManifest(directory, existingManifest, simulatorOrigin)
      : await seedPilot(saved, env, directory, 'healthy', false, {
          endpoint: simulatorOrigin,
          token,
          runId: 'operations',
          ...simulatorInstances(run),
          ...(demo ? { demo } : {}),
          // Cin7 pacing only spaces requests below a provider rate limit. Without simulated
          // limits it would make journeys wait about a second per request without testing
          // anything.
          ...(run.chaosProfile.transport.rateLimits
            ? {}
            : { cin7RequestIntervalMs: 0 }),
        });
    pilot = await createPilot(env, directory, manifest, temporal, {
      ...(modelGateway ? { modelGateway } : {}),
      ...(supplierExtraction ? { supplierExtraction } : {}),
      ...(detection ? { detection } : {}),
      ...(observability ? { observability } : {}),
    });
    const apiOrigin = await pilot.app.listen({ host: '127.0.0.1', port: 0 });
    await registerWebhooks(call, manifest, apiOrigin);
    client = createOperationsClient({
      apiOrigin,
      webOrigin: env.BETTER_AUTH_URL,
      password: saved.seedPassword,
      organizationId: manifest.organizationId,
      runId: manifest.simulator.runId,
    });

    return {
      pilot,
      password: saved.seedPassword,
      simulator,
      manifest,
      call,
      simulatorOrigin,
      apiOrigin,
      token,
      /** Private in-memory inputs for a separately restarted synthetic reconciliation worker. */
      purchasingWorkerConfiguration: () => ({ env, directory, manifest }),
      /** Waits until the run is ready again, for example after a reset. */
      ready: () => waitForRun(call, 'operations'),
      /** Recreates every API service against the same isolated state, exercising restart fences. */
      async restartPilot({ featureOverrides } = {}) {
        await pilot.close();
        if (featureOverrides)
          env = {
            ...env,
            FEATURE_FLAG_OVERRIDES: Object.entries(featureOverrides)
              .map(([flag, enabled]) => `${flag}=${enabled}`)
              .join(','),
          };
        pilot = await createPilot(env, directory, manifest, temporal, {
          ...(modelGateway ? { modelGateway } : {}),
          ...(supplierExtraction ? { supplierExtraction } : {}),
          ...(detection ? { detection } : {}),
          ...(observability ? { observability } : {}),
        });
        const restartedOrigin = await pilot.app.listen({
          host: '127.0.0.1',
          port: 0,
        });
        await registerWebhooks(call, manifest, restartedOrigin);
        client = createOperationsClient({
          apiOrigin: restartedOrigin,
          webOrigin: env.BETTER_AUTH_URL,
          password: saved.seedPassword,
          organizationId: manifest.organizationId,
          runId: manifest.simulator.runId,
        });

        return pilot;
      },
      async close() {
        await pilot.close();
        await simulator.close();
      },
    };
  } catch (error) {
    await pilot?.close();
    await simulator.close();
    throw error;
  }
}

/** Points a seeded workspace's manifest at the simulator host now serving its run. */
async function useManifest(directory, manifest, endpoint) {
  const current = {
    ...manifest,
    simulator: { ...manifest.simulator, endpoint },
  };
  await writeFile(
    join(directory, 'pilot.json'),
    `${JSON.stringify(current, null, 2)}\n`,
    { mode: 0o600 },
  );

  return current;
}
