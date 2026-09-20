import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { fail, run } from './process.mjs';

const suites = {
  test: [['test:local']],
  e2e: [
    ['exec', 'turbo', 'run', 'build', '--filter=@luma/api...'],
    ['--filter', '@luma/api', 'test:e2e'],
  ],
  browser: [
    ['exec', 'turbo', 'run', 'build', '--filter=@luma/api...'],
    ['--filter', '@luma/api', 'test:browser'],
  ],
  full: [['check'], ['test:e2e'], ['test:browser']],
};
let container;
try {
  const suite = process.argv[2];
  const commands = suites[suite]?.map((args) => [...args]);
  if (!commands) throw new Error('Expected test, e2e, browser or full');
  const extraArgs = process.argv.slice(3);
  if (extraArgs.length) {
    if (!['e2e', 'browser'].includes(suite))
      throw new Error('Test arguments are supported only for e2e and browser');
    commands.at(-1).push(...extraArgs);
  }
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    console.log('Starting disposable PostgreSQL 17 with Testcontainers…');
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
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
