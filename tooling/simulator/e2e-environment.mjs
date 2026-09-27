import { createApp } from '../../apps/simulator/dist/app.js';
import { createPilot } from '../pilot/runtime.mjs';
import { seedPilot } from '../pilot/seed.mjs';
import { createOperationsClient } from './platform-client.mjs';

/** Starts an isolated healthy Luma workspace and simulator using the same provisioning and HTTP bridge as the local stack. */
export async function createSimulatorEnvironment({
  directory,
  env,
  saved,
  temporal = null,
}) {
  const token = 'operational-simulator-test-token';
  let operations;
  const simulator = await createApp(
    `${directory}/runs.sqlite`,
    token,
    false,
    undefined,
    (runId, action) => operations(runId, action),
  );
  let pilot;
  try {
    const simulatorOrigin = await simulator.listen({
      host: '127.0.0.1',
      port: 0,
    });
    const call = async (path, body) => {
      const response = await fetch(`${simulatorOrigin}/api/${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(`${response.status}: ${JSON.stringify(result)}`);

      return result;
    };
    await call('runs', { id: 'operations', scenario: 'manual', seed: 44 });
    const manifest = await seedPilot(saved, env, directory, 'healthy', false, {
      endpoint: simulatorOrigin,
      token,
      runId: 'operations',
    });
    pilot = await createPilot(env, directory, manifest, temporal);
    const apiOrigin = await pilot.app.listen({ host: '127.0.0.1', port: 0 });
    operations = createOperationsClient({
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
