import type { TenantContext } from '@luma/identity';
import {
  IdentityError,
  requirePermission,
  requireTenant,
} from '@luma/identity';

import type { IncomingStock, IncomingStockQuery } from '../domain/incoming.js';

/** Serves incoming inventory with refreshed tenant membership and an explicit release gate. */
export function createIncomingStock(deps: {
  refreshContext(context: TenantContext): Promise<TenantContext>;
  enabled(context: TenantContext): Promise<boolean>;
  read(
    context: TenantContext,
    input: { skuIds: string[]; locationId?: string | undefined },
  ): Promise<Omit<IncomingStock, 'enabled'>>;
  parse(input: unknown): IncomingStockQuery;
  now(): Date;
}) {
  return {
    /** Reads bounded evidence for products and optional receiving location; this service never changes stock. */
    async read(context: TenantContext, input: unknown): Promise<IncomingStock> {
      const fresh = await deps.refreshContext(context);
      requireTenant(fresh, context.tenantId);
      if (fresh.actor.id !== context.actor.id)
        throw new IdentityError(403, 'FORBIDDEN', 'Sign in again to continue.');
      requirePermission(fresh, 'inventory.read');
      const query = deps.parse(input);
      const enabled = await deps.enabled(fresh);

      return enabled
        ? { enabled, ...(await deps.read(fresh, query)) }
        : {
            enabled,
            items: [],
            truncated: false,
            supplierOrdersUnavailable: false,
            unavailableNativeIncoming: false,
            asOf: deps.now().toISOString(),
          };
    },
  };
}
