import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { provision } from '../dev/database.mjs';
import {
  compose,
  environment,
  saveEnvironment,
  state,
  stateDirectory,
} from '../dev/environment.mjs';
import { fail, run } from '../dev/process.mjs';
import { startTelemetry } from '../observability/runtime.mjs';
import { provisionSimulatorDatabase, simulatorPassword } from './database.mjs';
import { createOperationsClient } from './platform-client.mjs';

let simulator;
let telemetry;

/**
 * Moves a workspace provisioned for the SQLite simulator aside: its connections have no
 * webhook secret or instance list, so the next start provisions a new workspace.
 */
async function archiveLegacyState(directory) {
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(join(directory, 'pilot.json'), 'utf8'),
    );
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (manifest.simulator?.webhookSecret && manifest.simulator?.instances)
    return;
  const backup = join(
    stateDirectory,
    'backups',
    `simulator-legacy-${Date.now()}`,
  );
  await mkdir(join(stateDirectory, 'backups'), { recursive: true });
  await rename(directory, backup);
  console.log(`Archived the previous simulator workspace to ${backup}.`);
}

try {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Simulator is for local development');
  const { values: flags } = parseArgs({
    options: {
      profile: { type: 'string', default: 'large' },
      erp: { type: 'string' },
      chaos: { type: 'string', default: 'realistic' },
      seed: { type: 'string', default: '44' },
      'history-days': { type: 'string' },
      'approval-required': { type: 'boolean', default: false },
      'demo-workflows': { type: 'boolean', default: true },
      detection: { type: 'string', default: 'demo' },
    },
    allowNegative: true,
  });
  if (!['demo', 'production'].includes(flags.detection))
    throw new Error('--detection must be demo or production');
  if (flags.erp !== undefined && !['jtl', 'cin7'].includes(flags.erp))
    throw new Error('--erp must be jtl or cin7');
  const historyDays =
    flags['history-days'] === undefined
      ? undefined
      : Number(flags['history-days']);
  if (
    historyDays !== undefined &&
    !(Number.isFinite(historyDays) && historyDays >= 0 && historyDays <= 14)
  )
    throw new Error('--history-days must be a number from 0 to 14');
  const saved = await state(true);
  await compose(saved, [
    '--profile',
    'workflows',
    '--profile',
    'observability',
    'up',
    '--detach',
    '--wait',
    '--wait-timeout',
    '120',
    'postgres',
    'temporal',
    'grafana',
  ]);
  const { generated, migrationUrl, webOrigin } = await environment(
    saved,
    true,
    true,
  );
  await provision(saved, migrationUrl);
  await saveEnvironment(generated);
  console.log(
    `Grafana: http://${await compose(saved, ['port', 'grafana', '3000'], true)}/d/luma-local`,
  );
  await writeFile(
    join(stateDirectory, 'simulator-login.json'),
    JSON.stringify({
      email: 'pilot-operator@example.test',
      password: saved.seedPassword,
    }),
    { mode: 0o600 },
  );
  await run('pnpm', [
    'exec',
    'turbo',
    'run',
    'build',
    '--filter=@luma/api...',
    '--filter=@luma/simulator...',
    '--filter=@luma/simulator-web',
  ]);
  // These helpers import workspace packages whose build output must exist first.
  const { registerWebhooks, simulatorInstances, waitForRun } =
    await import('./connect.mjs');
  const { configureDemoSuppliers } = await import('./demo.mjs');
  const databaseUrl = await provisionSimulatorDatabase(migrationUrl, {
    database: 'luma_simulator',
    role: 'luma_simulator',
    password: simulatorPassword(saved),
  });
  ({ telemetry } = await startTelemetry(generated, 'luma-simulator'));
  const { createApp } = await import('../../apps/simulator/dist/app.js');
  const directory = join(stateDirectory, 'simulator');
  await archiveLegacyState(directory);
  await mkdir(directory, { recursive: true });
  const token = 'local-synthetic-simulator-token';
  let client;
  simulator = await createApp({
    databaseUrl,
    token,
    operations: (id, action) =>
      client
        ? client.operations(id, action)
        : Promise.resolve({ connected: false }),
    luma: (id) =>
      client ? client.cases(id) : Promise.reject(new Error('Luma is starting')),
  });
  await simulator.listen({ host: '127.0.0.1', port: 5890 });
  const call = async (path, payload, method) => {
    const response = await simulator.inject({
      method: method ?? (payload ? 'POST' : 'GET'),
      url: `/api/${path}`,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload } : {}),
    });
    if (response.statusCode >= 300) throw new Error(response.body);

    return response.json();
  };
  const runId = 'pilot-44';
  const created = !(await call('runs')).some((item) => item.id === runId);
  if (created) {
    console.log(
      `Creating simulator run ${runId}: ${flags.profile} merchant on ${flags.erp === 'cin7' ? 'Cin7 Core' : flags.erp === 'jtl' ? 'JTL-Wawi' : 'its usual ERP'}, ${flags.chaos} failures.`,
    );
    await call('runs', {
      id: runId,
      seed: Number(flags.seed),
      profile: flags.profile,
      ...(flags.erp ? { erp: flags.erp } : {}),
      ...(historyDays === undefined ? {} : { historyDays }),
      chaos: flags.chaos,
      running: true,
    });
  }
  const ready = await waitForRun(call, runId, {
    timeoutMs: 1_800_000,
    report: (line) => console.log(`Simulator: ${line}`),
  });
  const { seedPilot } = await import('../pilot/seed.mjs');
  const manifest = await seedPilot(
    saved,
    generated,
    directory,
    flags['approval-required'] ? 'approval-required' : 'healthy',
    false,
    {
      endpoint: 'http://127.0.0.1:5890',
      token,
      runId,
      ...simulatorInstances(ready),
      demo: {
        workflows: flags['demo-workflows'],
        detection: flags.detection,
      },
    },
  );
  await registerWebhooks(call, manifest, `http://127.0.0.1:${generated.PORT}`);
  // Only a new run gets the demo's supplier answers; later panel changes are kept.
  if (created) await configureDemoSuppliers(call, manifest);
  client = createOperationsClient({
    apiOrigin: `http://127.0.0.1:${generated.PORT}`,
    webOrigin,
    password: saved.seedPassword,
    organizationId: manifest.organizationId,
    runId: manifest.simulator.runId,
  });
  await writeFile(
    join(directory, 'transport.json'),
    JSON.stringify(
      { ...manifest.simulator, webhookSecret: undefined },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    `SIMULATED CONNECTIONS · run ${runId} · ${ready.profile.label} · ${ready.chaos.preset} failures\nControl panel: http://127.0.0.1:5890\nLuma: ${webOrigin}\nManifest: ${directory}/pilot.json\nThe run keeps real time. Use Chaos to change failure rates and Scorecard to see what Luma detected.`,
  );
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...generated,
    LUMA_PILOT_DIRECTORY: directory,
  };
  const stop = () => void simulator.close();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await Promise.all([
      run('node', ['tooling/pilot/process.mjs'], { env }),
      run('node', ['tooling/pilot/process.mjs', '--worker'], { env }),
      run('pnpm', ['--filter', '@luma/web', 'dev'], { env }),
    ]);
  } finally {
    process.emit('SIGTERM');
    await simulator.close();
    await telemetry?.shutdown();
  }
} catch (error) {
  await simulator?.close();
  await telemetry?.shutdown();
  fail(error);
}
