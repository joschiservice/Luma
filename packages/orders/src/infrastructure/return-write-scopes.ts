import type { SqlTransaction } from '@luma/platform';

/**
 * Requesters with return creations, settlements or exchange steps that still need a background
 * step, across workspaces. Runs outside tenant scope through a SECURITY DEFINER function that
 * returns routing identities only; the pass then reauthorizes each requester in tenant scope.
 * Suspended, disabled and erased requesters and inactive workspaces are left out.
 */
export async function listReturnWriteScopes(db: Pick<SqlTransaction, 'query'>) {
  return (
    await db.query<{ tenant_id: string; principal_id: string }>(
      'SELECT tenant_id,principal_id FROM orders_return_write_scopes()',
    )
  ).rows.map((row) => ({
    tenantId: row.tenant_id,
    principalId: row.principal_id,
  }));
}
