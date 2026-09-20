import { join } from 'node:path';
import {
  compose,
  environment,
  saveEnvironment,
  state,
  stateDirectory,
} from '../dev/environment.mjs';
import { provision } from '../dev/database.mjs';
import { fail, run } from '../dev/process.mjs';

try {
  if (Number(process.versions.node.split('.')[0]) !== 24)
    throw new Error('Use Node 24 through mise exec.');
  const command = process.argv[2] ?? 'serve';
  if (!['seed', 'reset', 'serve', 'worker'].includes(command))
    throw new Error('Expected seed, reset, serve or worker');
  if (process.env.NODE_ENV === 'production')
    throw new Error('The synthetic pilot is for local development only');
  const saved = await state();
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
  await run('pnpm', ['exec', 'turbo', 'run', 'build', '--filter=@luma/api...']);
  const { seedPilot } = await import('./seed.mjs');
  const manifest = await seedPilot(
    saved,
    generated,
    stateDirectory,
    process.argv[3] ?? 'approval-required',
    command === 'reset',
  );
  console.log(
    `SIMULATED EXTERNAL SYSTEMS · ${manifest.scenario}\nOrganization: ${manifest.organizationId}\nWeb: ${webOrigin}\nLocal web target: http://127.0.0.1:${saved.webPort}\nManifest: .luma/pilot.json`,
  );
  // Start the API without inherited provider/model/telemetry credentials or API .env files.
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...generated,
    LUMA_PILOT_DIRECTORY: stateDirectory,
  };
  if (command === 'worker')
    await run('node', ['tooling/pilot/process.mjs', '--worker'], { env });
  if (command === 'serve') {
    console.log(
      'Run pnpm pilot:worker in a second terminal. Stop both commands before resetting.',
    );
    try {
      await Promise.all([
        run('node', ['tooling/pilot/process.mjs'], { env }),
        run('pnpm', ['--filter', '@luma/web', 'dev'], { env }),
      ]);
    } catch (error) {
      // The shared process runner forwards this to any surviving child group.
      process.emit('SIGTERM');
      throw error;
    }
  }
  if (['seed', 'reset'].includes(command))
    console.log(
      `Run pnpm pilot and pnpm pilot:worker. Credentials use the password in ${join(stateDirectory, 'demo.json')}.`,
    );
} catch (error) {
  fail(error);
}
