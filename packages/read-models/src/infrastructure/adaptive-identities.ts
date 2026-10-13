import type { TenantContext } from '@luma/identity';
import { hasPermission, requireTenant } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

/** Supplies bounded canonical warehouse identities without inferring their geography. */
export function createAdaptiveViewIdentities(db: TenantDatabase) {
  return async (context: TenantContext) => {
    requireTenant(context, context.tenantId);
    if (!hasPermission(context, 'inventory.read'))
      return { items: [], complete: true };

    return db.transaction(context.tenantId, async (tx) => {
      const result = await tx.query<{ id: string; label: string }>(
        `SELECT id,CASE WHEN left(reconciliation_key,10)='["source",' THEN 'Location '||regexp_replace(reconciliation_key::jsonb->>4,'^.*/','') ELSE reconciliation_key END AS label FROM inventory_entities WHERE tenant_id=$1 AND kind='location' ORDER BY id LIMIT 1001`,
        [context.tenantId],
      );

      return {
        items: result.rows
          .slice(0, 1000)
          .map((item) => ({ kind: 'location' as const, ...item })),
        complete: result.rows.length <= 1000,
      };
    });
  };
}
