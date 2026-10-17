import type { SqlTransaction } from '@luma/platform';

/** Checks that the current database login can read workspace app installations; throws when it can't. */
export async function requireWorkspaceAppsReadable(
  db: Pick<SqlTransaction, 'query'>,
) {
  await db.query('SELECT app_id FROM workspace_apps LIMIT 0');
}
