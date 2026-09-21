import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { provision } from '../dev/database.mjs';
import {
  compose,
  environment,
  saveEnvironment,
  state,
  stateDirectory,
} from '../dev/environment.mjs';
import { fail, run } from '../dev/process.mjs';

let simulator;

try {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Simulator is for local development');
  const saved = await state(true);
  await compose(saved, [
    '--profile',
    'workflows',
    'up',
    '--detach',
    '--wait',
    '--wait-timeout',
    '120',
    'postgres',
    'temporal',
  ]);
  const { generated, migrationUrl, webOrigin } = await environment(saved, true);
  await provision(saved, migrationUrl);
  await saveEnvironment(generated);
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
  ]);
  const { createApp } = await import('../../apps/simulator/dist/app.js');
  const directory = join(stateDirectory, 'simulator');
  await mkdir(directory, { recursive: true });
  const token = 'local-synthetic-simulator-token';
  simulator = await createApp(join(directory, 'runs.sqlite'), token);
  await simulator.listen({ host: '127.0.0.1', port: 5890 });
  const call = async (path, payload) => {
    const response = await simulator.inject({
      method: 'POST',
      url: `/api/${path}`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    if (response.statusCode >= 300) throw new Error(response.body);

    return response.json();
  };
  const existing = await simulator.inject({
    url: '/api/runs',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!existing.json().some((run) => run.id === 'pilot-44')) {
    await call('runs', { id: 'pilot-44', seed: 44, scenario: 'commerce' });
  }
  const { seedPilot } = await import('../pilot/seed.mjs');
  const manifest = await seedPilot(
    saved,
    generated,
    directory,
    'approval-required',
    false,
    { endpoint: 'http://127.0.0.1:5890', token, runId: 'pilot-44' },
  );
  await writeFile(
    join(directory, 'transport.json'),
    JSON.stringify(manifest.simulator, null, 2),
    { mode: 0o600 },
  );
  console.log(
    `SIMULATED CONNECTIONS · run pilot-44\nControl panel: http://127.0.0.1:5890\nLuma: ${webOrigin}\nManifest: ${directory}/pilot.json\nAPI and worker share manifest bindings. Start commerce with Start / Resume.`,
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
  }
} catch (error) {
  await simulator?.close();
  fail(error);
}
