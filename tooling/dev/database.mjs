import { Pool } from 'pg';
import { run } from './process.mjs';

export async function provision(saved, migrationUrl) {
  await run('pnpm', ['--filter', '@luma/api', 'db:migrate'], {
    env: { ...process.env, MIGRATION_DATABASE_URL: migrationUrl },
  });
  const pool = new Pool({
    connectionString: migrationUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('luma_local_roles'))",
    );
    for (const [name, password, grants] of [
      ['luma_api', saved.apiPassword, 'luma_identity'],
      [
        'luma_worker',
        saved.workerPassword,
        'luma_exceptions,luma_policies,luma_execution,luma_audit',
      ],
    ]) {
      const exists = await client.query(
        'SELECT 1 FROM pg_roles WHERE rolname = $1',
        [name],
      );
      if (!exists.rowCount)
        await client.query(
          `CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
        );
      // PostgreSQL utility statements do not accept password parameters; quote on the server.
      const quoted = await client.query(
        'SELECT quote_literal($1) AS password',
        [password],
      );
      await client.query(
        `ALTER ROLE ${name} PASSWORD ${quoted.rows[0].password}`,
      );
      await client.query(`GRANT ${grants} TO ${name}`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
