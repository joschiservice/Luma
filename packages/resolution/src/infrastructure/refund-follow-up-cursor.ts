import type { TenantContext } from '@luma/identity';
import { requireTenant } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

/** Stores bounded refund-monitor progress per tenant and view, so restarts retain the next page. */
export function createRefundFollowUpCursor(db: TenantDatabase) {
  return {
    async get(context: TenantContext, view: 'action' | 'waiting') {
      requireTenant(context, context.tenantId);

      return db.transaction(
        context.tenantId,
        async (tx) =>
          (
            await tx.query<{ cursor: string | null }>(
              'SELECT cursor FROM resolution_refund_follow_up_cursors WHERE tenant_id=$1 AND view=$2',
              [context.tenantId, view],
            )
          ).rows[0]?.cursor ?? null,
      );
    },
    async save(
      context: TenantContext,
      view: 'action' | 'waiting',
      cursor: string | null,
    ) {
      requireTenant(context, context.tenantId);
      await db.transaction(context.tenantId, async (tx) => {
        await tx.query(
          'INSERT INTO resolution_refund_follow_up_cursors(tenant_id,view,cursor) VALUES($1,$2,$3) ON CONFLICT(tenant_id,view) DO UPDATE SET cursor=EXCLUDED.cursor',
          [context.tenantId, view, cursor],
        );
      });
    },
  };
}
