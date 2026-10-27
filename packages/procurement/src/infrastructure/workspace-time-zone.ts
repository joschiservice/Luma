import type { SqlTransaction } from '@luma/platform';

/**
 * Reads the workspace's display time zone, which sets the calendar day for overdue delivery
 * dates. Identity owns the setting; procurement only reads it. Defaults to UTC when unset.
 */
export async function readWorkspaceTimeZone(
  tx: SqlTransaction,
  tenantId: string,
): Promise<string> {
  const row = (
    await tx.query<{ timezone: string }>(
      'SELECT timezone FROM workspace_settings WHERE tenant_id=$1',
      [tenantId],
    )
  ).rows[0];

  return row?.timezone ?? 'UTC';
}
