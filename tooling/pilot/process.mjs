import { join } from 'node:path';

import { startTelemetry } from '../observability/runtime.mjs';
import { startObservations } from '../simulator/observations.mjs';
import { readJson } from './fixtures.mjs';
import { startJourney } from './journey.mjs';

const directory = process.env.LUMA_PILOT_DIRECTORY;
if (!directory || process.env.NODE_ENV === 'production')
  throw new Error('A local pilot directory is required');

const { settings, telemetry } = await startTelemetry(
  process.env,
  process.argv.includes('--worker') ? 'luma-pilot-worker' : 'luma-pilot-api',
);
let pilot, observability, worker, client, running, stopObservations;
let closing;

function stop() {
  return (closing ??= (async () => {
    try {
      if (running) worker.shutdown();
      await running?.catch(() => {
        // Finish closing clients even if the worker has failed.
      });
      await worker?.close();
      await client?.close();
      await stopObservations?.();
      await pilot?.close();
    } finally {
      if (!pilot?.app) await observability?.shutdown();
      await telemetry?.shutdown();
    }
  })());
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  const { createPilot } = await import('./runtime.mjs');
  const { createObservability } = await import('@luma/platform/composition');
  observability = createObservability({ ...settings, approvedModels: [] });
  const manifest = await readJson(join(directory, 'pilot.json'));
  const temporal = {
    captureActivityError: observability.captureActivityError,
    address: process.env.TEMPORAL_ADDRESS,
    namespace: 'default',
    taskQueue: `luma-pilot-${manifest.runId}`,
    dataRegion: 'EU',
    telemetry,
  };
  pilot = await createPilot(process.env, directory, manifest, temporal, {
    observability,
    role: process.argv.includes('--worker') ? 'worker' : 'api',
  });
  if (process.argv.includes('--worker')) {
    worker = await pilot.runtime.createWorker();
    client = await pilot.runtime.createClient();
    running = worker.run();
    console.log(`Synthetic pilot worker PID: ${process.pid}`);
    await startJourney(pilot, manifest, client);
    await running;
    await stop();
  } else {
    const address = await pilot.app.listen({
      host: '127.0.0.1',
      port: Number(process.env.PORT),
    });
    console.log(`Synthetic pilot API: ${address}`);
    if (manifest.simulator)
      stopObservations = startObservations(pilot.observe, (error) =>
        pilot.app.log.error(error),
      );
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  await stop();
}
