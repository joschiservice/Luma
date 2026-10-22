import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { dropScenarioSnapshots } from './scenario-snapshots.mjs';

const migrate = fileURLToPath(
  new URL(
    '../../../packages/application-runtime/scripts/migrate.mjs',
    import.meta.url,
  ),
);

/**
 * Migrates one template database for a journey run and publishes its name in
 * `LUMA_E2E_TEMPLATE_DATABASE`, so each journey copies it instead of migrating its own database.
 * Runs as the Vitest and Playwright global setup, before workers start and inherit the variable.
 * Without `TEST_DATABASE_URL` it does nothing; journeys then fail on their own database check.
 * Returns the teardown that drops the template and the imported scenario snapshots named after
 * it.
 */
export default async function prepareTemplateDatabase() {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl || process.env.LUMA_E2E_TEMPLATE_DATABASE) return () => {};
  const name = `e2e_template_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const owner = new Pool({ connectionString: url.toString(), max: 1 });
  try {
    // Shared runtime roles are cluster-wide, as in `database(t).migrate()`.
    await admin.query(
      "SELECT pg_advisory_lock(hashtext('luma_test_role_setup'))",
    );
    try {
      const child = spawn(process.execPath, [migrate], {
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'test',
          MIGRATION_DATABASE_URL: url.toString(),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (data) => (output += data));
      child.stderr.on('data', (data) => (output += data));
      const [code] = await once(child, 'close');
      if (code !== 0) throw new Error(`Template migration failed:\n${output}`);
    } finally {
      await admin.query(
        "SELECT pg_advisory_unlock(hashtext('luma_test_role_setup'))",
      );
    }
    await owner.query('SELECT luma_provision_cell_region($1)', [
      process.env.LUMA_REGION ?? 'AU',
    ]);
  } catch (error) {
    await owner.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
    throw error;
  }
  // A database can only be copied while nobody is connected to it.
  await owner.end();
  process.env.LUMA_E2E_TEMPLATE_DATABASE = name;

  return async () => {
    try {
      await dropScenarioSnapshots(admin, name);
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    } finally {
      await admin.end();
    }
  };
}
