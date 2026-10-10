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
 * JTL with `calm` failures unless options choose otherwise; its clock only moves when tests advance it.
 */
export async function createSimulatorEnvironment({
  t,
  directory,
  env,
  saved,
  temporal = null,
  profile = 'test',
  erp = 'jtl',
  chaos = 'calm',
  detection,
  demo,
}) {
  const token = 'operational-simulator-test-token';
  const databaseUrl = await testSimulatorDatabase(t);
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
    await call('runs', {
      id: 'operations',
      profile,
      erp,
      chaos,
      seed: 44,
      running: false,
    });
    const run = await waitForRun(call, 'operations');
    const manifest = await seedPilot(saved, env, directory, 'healthy', false, {
      endpoint: simulatorOrigin,
      token,
      runId: 'operations',
      ...simulatorInstances(run),
      ...(demo ? { demo } : {}),
    });
    pilot = await createPilot(env, directory, manifest, temporal, {
      ...(detection ? { detection } : {}),
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
      /** Waits until the run is ready again, for example after a reset. */
      ready: () => waitForRun(call, 'operations'),
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
