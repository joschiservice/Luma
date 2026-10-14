import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import type { DataRegion } from '@luma/config';
import { readRegionConfig } from '@luma/config';
import { Pool } from 'pg';

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
    for (const file of (
      await readdir(new URL('../../migrations/', import.meta.url))
    ).sort())
      if (file.endsWith('.sql'))
        await owner.query(
          await readFile(
            new URL(`../../migrations/${file}`, import.meta.url),
            'utf8',
          ),
        );
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
