import { hasPermission, type TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

/**
 * Summarizes stock differences still waiting for sync propagation before detection judges them:
 * how many SKUs wait and the earliest wait end (UTC ISO). People without `inventory.read`
 * receive nothing rather than a count.
 */
export function createPendingStockSyncReader(database: TenantDatabase) {
  return async (
    context: TenantContext,
  ): Promise<{ count: number; until: string | null } | undefined> => {
    if (!hasPermission(context, 'inventory.read')) return undefined;

    return database.transaction(
      context.tenantId,
      async (tx) =>
        (
          await tx.query<{ count: number; until: string | null }>(
            `SELECT count(*)::int AS count,to_char(min(wait_until) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS until FROM exception_pending_sync WHERE tenant_id=$1 AND subject_kind='sku'`,
            [context.tenantId],
          )
        ).rows[0]!,
    );
  };
}
