import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { startTelemetry } from '../observability/runtime.mjs';
import { readJson } from './fixtures.mjs';
import { startJourney } from './journey.mjs';

/**
 * Runs commerce sync in the background like the sync worker, one pass at a time and briefly
 * idle between passes. Once a minute it links the next SKUs a merchant reviewed, completes the
 * demo workflow setup, carries customers' quantity requests into Luma's records, and runs the
 * inventory scenario check and scheduled detection. Failures go to `log`. Returns a function
 * that stops after the current pass.
 */
function startSync(pilot, log) {
  let stopped = false;
  let checkedAt = 0;
  const loop = (async () => {
    while (!stopped) {
      const check = Date.now() - checkedAt >= 60_000;
      if (check) checkedAt = Date.now();
      await pilot
        .observe({ passes: 1, refresh: false, check })
        .catch((error) => log('Pilot sync pass failed', error));
      if (check)
        for (const step of [
          pilot.link,
          pilot.demo,
          pilot.quantityChanges,
          pilot.detect,
        ]) {
          if (stopped) break;
          await step().catch((error) => log('Pilot sync step failed', error));
        }
      await delay(2_000);
    }
  })();

  return async () => {
    stopped = true;
    await loop;
  };
}

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
// This process has its own process group, so terminal signals reach it only through its
// launcher. Stop when the launcher is gone instead of running on unattended.
const launcher = process.ppid;
setInterval(() => {
  if (process.ppid !== launcher) void stop();
}, 1_000).unref();

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
    if (manifest.simulator) {
      const { createFailureLog } = await import('@luma/platform');
      stopObservations = startSync(pilot, createFailureLog(observability));
    }
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  await stop();
}
