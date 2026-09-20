import { join } from 'node:path';
import { readJson } from './fixtures.mjs';
import { createPilot } from './runtime.mjs';
import { startJourney } from './journey.mjs';
const directory = process.env.LUMA_PILOT_DIRECTORY;
if (!directory || process.env.NODE_ENV === 'production')
  throw new Error('A local pilot directory is required');
const manifest = await readJson(join(directory, 'pilot.json'));
const temporal = {
  address: process.env.TEMPORAL_ADDRESS,
  namespace: 'default',
  taskQueue: `luma-pilot-${manifest.runId}`,
  dataRegion: 'EU',
};
const pilot = await createPilot(process.env, directory, manifest, temporal);
let worker, client, running;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (running) worker.shutdown();
  await running?.catch(() => {});
  await worker?.close();
  await client?.close();
  await pilot.close();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
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
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  await stop();
}
