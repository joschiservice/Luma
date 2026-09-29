import { PostgreSqlContainer } from '@testcontainers/postgresql';

import { fail, run } from './process.mjs';

const suites = {
  test: [['test:local']],
  e2e: [
    [
      'exec',
      'turbo',
      'run',
      'build',
      '--filter=@luma/api...',
      '--filter=@luma/worker...',
      '--filter=@luma/simulator...',
    ],
    ['--filter', '@luma/api', 'test:e2e'],
  ],
  browser: [
    [
      'exec',
      'turbo',
      'run',
      'build',
      '--filter=@luma/api...',
      '--filter=@luma/worker...',
      '--filter=@luma/simulator...',
    ],
    ['--filter', '@luma/api', 'test:browser'],
  ],
  full: [['check'], ['test:e2e'], ['test:browser']],
  // Prebuilt platform suites used by verify:feature after its single build step.
  simulator: [
    ['--filter', '@luma/api', 'test:e2e', 'simulator.e2e.mjs'],
    ['--filter', '@luma/api', 'test:browser', 'simulator.browser.mjs'],
  ],
};

let container;

try {
  const suite = process.argv[2];
  const commands = suites[suite]?.map((args) => [...args]);
  if (!commands)
    throw new Error('Expected test, e2e, browser, simulator or full');
  const extraArgs = process.argv.slice(3);
  if (extraArgs.length) {
    if (!['e2e', 'browser'].includes(suite))
      throw new Error('Test arguments are supported only for e2e and browser');
    commands.at(-1).push(...extraArgs);
  }
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
