import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';

import { affectedJourneys } from './affected.mjs';
import { fail, root, run } from './process.mjs';
import { testCommands } from './test-plan.mjs';

let container;

/**
 * Names the optional test dependencies present for this run. Turbo hashes the value so cached
 * results from runs that skipped database or Code Step suites are not reused when they can run.
 */
function capabilities(env) {
  return [
    env.TEST_DATABASE_URL && 'database',
    existsSync(join(root, '.luma/code-runtime/wasmtime')) && 'code-runtime',
  ]
    .filter(Boolean)
    .join(',');
}

try {
  const [suite, ...args] = process.argv.slice(2);
  const journeys =
    suite === 'affected' ||
    (['e2e', 'browser'].includes(suite) && args.includes('--affected'))
      ? affectedJourneys()
      : undefined;
  if (journeys) {
    console.log(
      journeys.reason
        ? `Running every journey: ${journeys.reason}.`
        : `Affected journeys for ${journeys.changed} changed files: ${
            [...journeys.e2e, ...journeys.browser].join(', ') || 'none'
          }.`,
    );
  }
  const commands = testCommands(suite, args, journeys);
  let url = process.env.TEST_DATABASE_URL;
  if (!url && suite !== 'local' && commands.length) {
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
  const env = { ...process.env, ...(url ? { TEST_DATABASE_URL: url } : {}) };
  env.LUMA_TEST_CAPABILITIES = capabilities(env);
  for (const args of commands) await run('pnpm', args, { env });
} catch (error) {
  fail(error);
} finally {
  await container?.stop();
}
