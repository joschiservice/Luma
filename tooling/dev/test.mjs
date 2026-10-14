import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer } from 'testcontainers';

import { affectedJourneys } from './affected.mjs';
import { fail, root, run } from './process.mjs';
import { testCommands } from './test-plan.mjs';
import { acquireValidation } from './validation-lock.mjs';

let container;
let admissionContainer;
let validation;

/**
 * Names the optional test dependencies present for this run. Turbo hashes the value so cached
 * results from runs that skipped database or Code Step suites are not reused when they can run.
 */
function capabilities(env) {
  return [
    env.TEST_DATABASE_URL && 'database',
    env.SHOPIFY_ADMISSION_URL && 'valkey',
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
  validation = await acquireValidation(root, {
    owner: process.env.LUMA_VALIDATION_OWNER,
    onWait: () =>
      console.log(
        'Another validation run is active in this checkout; waiting for it to finish.',
      ),
  });
  let url = process.env.TEST_DATABASE_URL;
  if (!url && !['local', 'ui'].includes(suite) && commands.length) {
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
  if (!['local', 'ui'].includes(suite) && commands.length) {
    console.log('Starting disposable Valkey for provider admission…');
    admissionContainer = await new GenericContainer(
      'valkey/valkey:9.1.2-alpine',
    )
      .withExposedPorts(6379)
      .start();
    env.SHOPIFY_ADMISSION_URL = `redis://${admissionContainer.getHost()}:${admissionContainer.getMappedPort(6379)}`;
  }
  if (suite === 'local' && !process.env.LUMA_VALIDATION_OWNER) {
    delete env.SHOPIFY_ADMISSION_URL;
    delete env.SHOPIFY_ADMISSION_CLUSTER;
  }
  env.LUMA_TEST_CAPABILITIES = capabilities(env);
  env.LUMA_VALIDATION_OWNER = validation.owner;
  for (const args of commands) await run('pnpm', args, { env });
} catch (error) {
  fail(error);
} finally {
  try {
    try {
      await admissionContainer?.stop();
    } finally {
      await container?.stop();
    }
  } finally {
    await validation?.release();
  }
}
