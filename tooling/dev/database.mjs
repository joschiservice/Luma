import { Pool } from 'pg';

import { run } from './process.mjs';

/** Applies database migrations and provisions restricted local API and worker roles. */
export async function provision(
  saved,
  migrationUrl,
  region = process.env.LUMA_REGION ?? 'AU',
) {
  await run('pnpm', ['--filter', '@luma/api', 'db:migrate'], {
    env: { ...process.env, MIGRATION_DATABASE_URL: migrationUrl },
  });
  // Loaded here so commands that import this module never load workspace packages first.
  const { provisionRuntimeLogins } =
    await import('@luma/application-runtime/runtime-logins');
  const pool = new Pool({
    connectionString: migrationUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  const client = await pool.connect();
  try {
    await client.query('SELECT luma_provision_cell_region($1)', [region]);
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
    await provisionRuntimeLogins(client, {
      luma_api: saved.apiPassword,
      luma_worker: saved.workerPassword,
      luma_staff: saved.staffPassword,
    });
  } finally {
    client.release();
    await pool.end();
  }
}
