import type { SqlTransaction } from '@luma/platform';

/**
 * Checks that the current database login may use connection storage safely: it inherits
 * `luma_connectors`, is neither superuser nor exempt from row security, and does not own the
 * connector tables. Returns false when the login is unsafe; throws when the tables can't be read.
 */
export async function connectionRuntimeReady(
  db: Pick<SqlTransaction, 'query'>,
) {
  const result = await db.query<{ safe: boolean }>(`SELECT
          NOT r.rolsuper AND NOT r.rolbypassrls
          AND pg_has_role(current_user, 'luma_connectors', 'MEMBER')
          AND NOT EXISTS (SELECT FROM pg_class c WHERE c.oid IN ('connector_installations'::regclass, 'connector_lifecycle_events'::regclass) AND pg_has_role(current_user, c.relowner, 'MEMBER')) AS safe
          FROM pg_roles r WHERE r.rolname = current_user`);
  if (result.rows[0]?.safe !== true) return false;
  await db.query('SELECT id FROM connector_installations LIMIT 0');

  return true;
}
