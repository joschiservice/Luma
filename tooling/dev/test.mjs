import { PostgreSqlContainer } from '@testcontainers/postgresql';

import { fail, run } from './process.mjs';
import { testCommands } from './test-plan.mjs';

let container;

try {
  const commands = testCommands(process.argv[2], process.argv.slice(3));
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    console.log('Starting disposable PostgreSQL 17 with Testcontainers…');
    // Suites drop their databases during teardown, and DROP DATABASE waits for a checkpoint.
    // Durable writes made each checkpoint take seconds under parallel suites; this server is disposable.
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withCommand([
        'postgres',
        '-c',
        'fsync=off',
        '-c',
        'full_page_writes=off',
        '-c',
        'synchronous_commit=off',
        // Parallel journeys each open identity, application and provider pools.
        '-c',
        'max_connections=300',
      ])
      .start();
    url = container.getConnectionUri();
  }
  for (const args of commands)
    await run('pnpm', args, {
      env: { ...process.env, TEST_DATABASE_URL: url },
    });
} catch (error) {
  fail(error);
} finally {
  await container?.stop();
}
