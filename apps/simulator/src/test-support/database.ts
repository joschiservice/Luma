import { randomUUID } from 'node:crypto';

import pg from 'pg';

import { migrate } from '../migrate.js';

/**
 * Creates a disposable simulator database and runtime role on `TEST_DATABASE_URL` and returns
 * the runtime connection and a cleanup function.
 */
export async function disposableDatabase(adminUrl: string) {
  const name = `sim_${randomUUID().replaceAll('-', '')}`;
  const password = randomUUID();
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(
    `CREATE ROLE ${name} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
  );
  await admin.query(`CREATE DATABASE ${name}`);
  const owner = new URL(adminUrl);
  owner.pathname = `/${name}`;
  await migrate(owner.toString(), name);
  const runtime = new URL(owner);
  runtime.username = name;
  runtime.password = password;

  return {
    url: runtime.toString(),
    async drop() {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${name}`);
      await admin.end();
    },
  };
}
