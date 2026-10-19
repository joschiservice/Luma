/**
 * Runtime database logins and the domain group roles each inherits. Migrations create the
 * group roles; these logins never receive migration, role creation or RLS bypass privileges.
 */
const runtimeLogins = {
  luma_api: [
    'luma_identity',
    'luma_connectors',
    'luma_case_reader',
    'luma_desk',
    'luma_commerce_sync',
    'luma_sales',
    'luma_adaptive',
  ],
  luma_worker: [
    'luma_exceptions',
    'luma_policies',
    'luma_execution',
    'luma_audit',
    'luma_connectors',
    'luma_orders',
    'luma_inventory',
    'luma_desk',
    'luma_commerce_sync',
    'luma_customers',
    'luma_sales',
    'luma_adaptive',
  ],
  luma_staff: ['luma_staff_runtime'],
};

/**
 * Creates missing runtime logins, sets their passwords and grants their group roles in one
 * transaction, through a migration administrator connection. Run it after migrations, which
 * create the group roles. Repeated runs replace passwords and never remove grants. Rolls back
 * and rethrows on any failure.
 * @param {import('pg').ClientBase} client
 * @param {Record<keyof typeof runtimeLogins, string>} passwords
 */
export async function provisionRuntimeLogins(client, passwords) {
  await client.query('BEGIN');
  try {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('luma_runtime_logins'))",
    );
    for (const [name, grants] of Object.entries(runtimeLogins)) {
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
        [passwords[/** @type {keyof typeof runtimeLogins} */ (name)]],
      );
      await client.query(
        `ALTER ROLE ${name} PASSWORD ${quoted.rows[0].password}`,
      );
      await client.query(`GRANT ${grants.join(',')} TO ${name}`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
