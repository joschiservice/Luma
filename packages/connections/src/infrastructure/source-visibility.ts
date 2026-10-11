import type { TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

/** Returns unreleased order-source IDs for read presentation; never changes authorization or records. */
export function createOrderSourceVisibility(
  db: TenantDatabase,
  internalOrdersEnabled: (tenantId: string) => Promise<boolean>,
) {
  return async (context: TenantContext): Promise<string[]> => {
    if (await internalOrdersEnabled(context.tenantId)) return [];

    return db.transaction(context.tenantId, async (tx) =>
      (
        await tx.query<{ id: string }>(
          "SELECT id FROM connector_installations WHERE tenant_id=$1 AND document->>'provider'='luma-erp'",
          [context.tenantId],
        )
      ).rows.map((row) => row.id),
    );
  };
}
