import type { SqlTransaction } from '@luma/platform';

/**
 * A database connection outside tenant scope. Discovery runs through SECURITY DEFINER functions
 * that return routing identities only; work then reauthorizes in tenant scope.
 */
type DiscoveryConnection = Pick<SqlTransaction, 'query'>;

/** Principals with active replenishment rules, one row per workspace and principal. */
export async function listReplenishmentScopes(db: DiscoveryConnection) {
  return (
    await db.query<{ tenant_id: string; principal_id: string }>(
      'SELECT * FROM replenishment_worker_scopes()',
    )
  ).rows.map((row) => ({
    tenantId: row.tenant_id,
    principalId: row.principal_id,
  }));
}

/** Principals with live purchase-order submissions to follow. */
export async function listSubmissionScopes(db: DiscoveryConnection) {
  return (
    await db.query<{ tenant_id: string; principal_id: string }>(
      'SELECT tenant_id,principal_id FROM procurement_submission_scopes()',
    )
  ).rows.map((row) => ({
    tenantId: row.tenant_id,
    principalId: row.principal_id,
  }));
}

/** Removes supplier message text past its retention, across workspaces, 200 messages per call. */
export async function purgeExpiredSupplierMessages(db: DiscoveryConnection) {
  await db.query('SELECT purge_expired_procurement_communications(200)');
}
