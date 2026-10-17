import type { SqlTransaction } from '@luma/platform';

/**
 * Workspaces whose commerce sync runs, with the principal the sync runs as. Call it on a
 * connection outside tenant scope: the SECURITY DEFINER function returns routing identities
 * only, and detection reauthorizes in tenant scope.
 */
export async function listDetectionScopes(db: Pick<SqlTransaction, 'query'>) {
  return (
    await db.query<{ tenant_id: string; principal_id: string }>(
      'SELECT tenant_id,principal_id FROM detection_worker_scopes()',
    )
  ).rows.map((row) => ({
    tenantId: row.tenant_id,
    principalId: row.principal_id,
  }));
}
