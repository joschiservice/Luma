import type { TenantDatabase } from '@luma/platform';

import type { TenantContext } from '../domain/context.js';
import { requireTenant } from '../domain/context.js';

/** Reads active role identities for validated sharing rules; it grants no role permissions. */
export function createRoleIdentityReader(db: TenantDatabase) {
  return async (context: TenantContext) => {
    requireTenant(context, context.tenantId);
    const rows = await db.transaction(context.tenantId, (tx) =>
      tx.query<{ id: string }>(
        'SELECT id FROM workspace_roles WHERE tenant_id=$1 AND archived_at IS NULL',
        [context.tenantId],
      ),
    );

    return ['owner', 'admin', 'member', ...rows.rows.map((row) => row.id)];
  };
}
