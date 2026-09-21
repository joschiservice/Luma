import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  compose,
  environment,
  saveEnvironment,
  state,
  stateDirectory,
} from './environment.mjs';
import { fail, root, run } from './process.mjs';

const command = process.argv[2];

try {
  if (Number(process.versions.node.split('.')[0]) !== 24)
    throw new Error(
      'Luma requires Node 24. Run mise install, then mise exec -- pnpm run setup.',
    );
  if (command === 'setup') {
    await run('pnpm', ['install', '--frozen-lockfile']);
    for (const pkg of ['@luma/ui', '@luma/api'])
      await run('pnpm', [
        '--filter',
        pkg,
        'exec',
        'playwright',
        'install',
        'chromium',
      ]);
  }
  if (
    !['setup', 'dev', 'workflows', 'seed', 'reset', 'down', 'doctor'].includes(
      command,
    )
  )
    throw new Error('Unknown development command');
  await run('docker', ['info', '--format', '{{.ServerVersion}}'], {
    capture: true,
  });
  const saved = await state(['setup', 'dev', 'workflows'].includes(command));
  if (command === 'down') {
    await compose(saved, ['--profile', 'workflows', 'down']);
  } else if (command === 'doctor') {
    console.log(
      `Node ${process.versions.node}; pnpm ${await run('pnpm', ['--version'], { capture: true })}`,
    );
    await compose(saved, ['--profile', 'workflows', 'ps']);
    const { env, generated, webOrigin } = await environment(saved);
    const { Pool } = await import('pg');
    for (const key of ['IDENTITY_DATABASE_URL', 'WORKFLOW_DATABASE_URL']) {
      const pool = new Pool({
        connectionString: env[key],
        connectionTimeoutMillis: 5000,
      });
      try {
        const {
          rows: [role],
        } = await pool.query(
          'SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = current_user',
        );
        if (Object.values(role).some(Boolean))
          throw new Error(`${key} must use a restricted login`);
        console.log(`${key}: connected with a restricted login`);
      } finally {
        await pool.end();
      }
    }
    const response = await fetch(`${generated.API_PROXY_TARGET}/ready`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok)
      throw new Error(`API readiness returned ${response.status}`);
    console.log(`API ready. Web: ${webOrigin}`);
  } else {
    const workflows = command === 'workflows';
    await compose(saved, [
      ...(workflows ? ['--profile', 'workflows'] : []),
      'up',
      '--detach',
      '--wait',
      '--wait-timeout',
      '120',
      'postgres',
      ...(workflows ? ['temporal'] : []),
    ]);
    const { generated, migrationUrl, env, webOrigin } = await environment(
      saved,
      workflows,
    );
    const { provision } = await import('./database.mjs');
    if (command === 'reset') {
      console.log('Recreating this worktree’s local database and demo data.');
      await compose(saved, [
        'exec',
        '-T',
        'postgres',
        'dropdb',
        '-U',
        'postgres',
        '--force',
        '--if-exists',
        'luma',
      ]);
      await compose(saved, [
        'exec',
        '-T',
        'postgres',
        'createdb',
        '-U',
        'postgres',
        'luma',
      ]);
    }
    await provision(saved, migrationUrl);
    await saveEnvironment(generated);
    if (['setup', 'seed', 'reset'].includes(command)) {
      await run('pnpm', [
        'exec',
        'turbo',
        'run',
        'build',
        '--filter=@luma/api...',
      ]);
      const { seed } = await import('./seed.mjs');
      await seed(saved, generated);
    }
    console.log(
      `Web: ${webOrigin}\nAPI: ${generated.API_PROXY_TARGET}\nLocal configuration: ${join(stateDirectory, 'env')}`,
    );
    if (workflows)
      console.log(
        `Temporal UI: http://${await compose(saved, ['port', 'temporal', '8233'], true)}`,
      );
    if (['dev', 'workflows'].includes(command)) {
      try {
        await access(join(root, 'apps/api/.env'));
        console.log(
          'Existing apps/api/.env is preserved. Managed database, ports and auth settings take precedence.',
        );
      } catch {
        /* No app overrides. */
      }
      await run(
        'pnpm',
        ['exec', 'turbo', 'run', 'dev', ...(workflows ? ['dev:worker'] : [])],
        { env },
      );
    } else {
      const credentials = JSON.parse(
        await readFile(join(stateDirectory, 'demo.json'), 'utf8'),
      );
      console.log(
        `Demo login: ${credentials.email}\nPassword is stored in .luma/demo.json\nRun pnpm dev to start the application.`,
      );
    }
  }
} catch (error) {
  fail(error);
}
