import { createHmac, randomUUID } from 'node:crypto';

import { Pool } from 'pg';

const quote = async (client, value) =>
  (await client.query('SELECT quote_literal($1) AS value', [value])).rows[0]
    .value;

/**
 * Creates the simulator database and its restricted runtime role on the administrator's
 * server when missing, applies simulator migrations and returns the runtime connection.
 * The simulator never shares Luma's database: Luma sees provider data only through APIs.
 * @param {string} adminUrl connection to an existing database as an administrator
 * @param {{ database: string; role: string; password: string }} target
 */
export async function provisionSimulatorDatabase(adminUrl, target) {
  for (const name of [target.database, target.role])
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name))
      throw new Error('Invalid simulator database or role name');
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    const client = await admin.connect();
    try {
      await client.query(
        "SELECT pg_advisory_lock(hashtext('luma_simulator_database'))",
      );
      const role = await client.query(
        'SELECT 1 FROM pg_roles WHERE rolname = $1',
        [target.role],
      );
      if (!role.rowCount)
        await client.query(
          `CREATE ROLE ${target.role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
        );
      await client.query(
        `ALTER ROLE ${target.role} PASSWORD ${await quote(client, target.password)}`,
      );
      const database = await client.query(
        'SELECT 1 FROM pg_database WHERE datname = $1',
        [target.database],
      );
      if (!database.rowCount)
        await client.query(`CREATE DATABASE ${target.database}`);
      await client.query(
        `GRANT CONNECT ON DATABASE ${target.database} TO ${target.role}`,
      );
    } finally {
      await client
        .query("SELECT pg_advisory_unlock(hashtext('luma_simulator_database'))")
        .catch(() => undefined);
      client.release();
    }
  } finally {
    await admin.end();
  }
  const owner = new URL(adminUrl);
  owner.pathname = `/${target.database}`;
  // Loaded on use: callers build the simulator after importing this module.
  const { migrate } = await import('../../apps/simulator/dist/migrate.js');
  await migrate(owner.toString(), target.role);
  const runtime = new URL(owner);
  runtime.username = target.role;
  runtime.password = target.password;

  return runtime.toString();
}

/**
 * Derives the local simulator role password from the worktree's database password, so
 * existing local state needs no new secret.
 * @param {{ databasePassword: string }} saved
 */
export const simulatorPassword = (saved) =>
  createHmac('sha256', saved.databasePassword)
    .update('luma_simulator')
    .digest('hex');

/**
 * Provisions a disposable simulator database for one test on `TEST_DATABASE_URL` and drops
 * it, with its role, when the test finishes.
 * @param {{ onTestFinished?: (callback: () => Promise<void>) => void; after?: (callback: () => Promise<void>) => void }} t
 */
export async function testSimulatorDatabase(t) {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl)
    throw new Error(
      'TEST_DATABASE_URL is required for simulator database tests',
    );
  const name = `sim_${randomUUID().replaceAll('-', '')}`;
  const url = await provisionSimulatorDatabase(adminUrl, {
    database: name,
    role: name,
    password: randomUUID(),
  });
  const cleanup = async () => {
    const admin = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${name}`);
    } finally {
      await admin.end();
    }
  };
  (t.onTestFinished ?? t.after).call(t, cleanup);

  return url;
}
