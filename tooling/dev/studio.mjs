import { compose, environment, state } from './environment.mjs';
import { fail, run } from './process.mjs';

try {
  const saved = await state();
  await compose(saved, [
    'up',
    '--detach',
    '--wait',
    '--wait-timeout',
    '120',
    'postgres',
  ]);
  const { migrationUrl } = await environment(saved);
  await run(
    'pnpm',
    [
      '--filter',
      '@luma/api',
      'exec',
      'drizzle-kit',
      'studio',
      '--config=drizzle.studio.config.ts',
      '--host=127.0.0.1',
    ],
    { env: { ...process.env, LUMA_STUDIO_DATABASE_URL: migrationUrl } },
  );
} catch (error) {
  fail(error);
}
