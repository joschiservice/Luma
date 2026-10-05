import { provision } from '../dev/database.mjs';
import { compose, environment, state } from '../dev/environment.mjs';
import { fail, run } from '../dev/process.mjs';
import { provisionSimulatorDatabase, simulatorPassword } from './database.mjs';

try {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Simulator is for local development');
  const saved = await state(true);
  await compose(saved, [
    'up',
    '--detach',
    '--wait',
    '--wait-timeout',
    '120',
    'postgres',
  ]);
  const { migrationUrl } = await environment(saved);
  await provision(saved, migrationUrl);
  const databaseUrl = await provisionSimulatorDatabase(migrationUrl, {
    database: 'luma_simulator',
    role: 'luma_simulator',
    password: simulatorPassword(saved),
  });
  await run('node', ['apps/simulator/dist/server.js'], {
    env: { ...process.env, LUMA_SIMULATOR_DATABASE_URL: databaseUrl },
  });
} catch (error) {
  fail(error);
}
