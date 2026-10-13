import { requireTenant, type TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

/** Retains connection-wide uncertainty while any Shopify stock claim lacks durable settlement. */
export function createShopifyUnsettledStockReader(db: TenantDatabase) {
  return async (
    context: TenantContext,
    connectionId: string,
  ): Promise<boolean> => {
    requireTenant(context, context.tenantId);

    return db.transaction(
      context.tenantId,
      async (tx) =>
        !!(
          await tx.query(
            'SELECT 1 FROM shopify_inventory_claims WHERE tenant_id=$1 AND connection_id=$2 AND NOT settled LIMIT 1',
            [context.tenantId, connectionId],
          )
        ).rowCount,
    );
  };
}
