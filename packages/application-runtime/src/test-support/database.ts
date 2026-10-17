import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import type { DataRegion } from '@luma/config';
import { readRegionConfig } from '@luma/config';
import { Pool } from 'pg';

/**
 * Lists core migrations in filename order, then each app's migrations in app directory and
 * filename order, as the migration runner applies them.
 */
async function migrationFiles() {
  const core = new URL('../../migrations/', import.meta.url);
  const apps = new URL('../../../apps/', import.meta.url);
  const files = (await readdir(core))
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => new URL(file, core));
  for (const app of (await readdir(apps, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()) {
    const directory = new URL(`${app}/migrations/`, apps);
    const names = await readdir(directory).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return [];
      throw error;
    });
    files.push(
      ...names
        .filter((file) => file.endsWith('.sql'))
        .sort()
        .map((file) => new URL(file, directory)),
    );
  }

  return files;
}

/**
 * Creates a database on the `TEST_DATABASE_URL` cluster with every migration applied and
 * returns its owner pool. Migrations create shared roles, so they run under the cluster-wide
 * setup lock. `drop` closes the pool and removes the database.
 */
export async function createMigratedDatabase(
  adminUrl: string,
  region: DataRegion = readRegionConfig(process.env).region,
) {
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: adminUrl });
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const owner = new Pool({ connectionString: url.toString() });
  const setup = await admin.connect();
  try {
    await setup.query(
      "SELECT pg_advisory_lock(hashtext('luma_test_role_setup'))",
    );
    for (const url of await migrationFiles())
      await owner.query(await readFile(url, 'utf8'));
    await owner.query('SELECT luma_provision_cell_region($1)', [region]);
  } finally {
    await setup.query(
      "SELECT pg_advisory_unlock(hashtext('luma_test_role_setup'))",
    );
    setup.release();
  }

  return {
    owner,
    async drop() {
      await owner.end();
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.end();
    },
  };
}
