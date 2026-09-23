import type { TenantContext } from '@luma/identity';
import { IdentityError, requireTenant } from '@luma/identity';

import type { ActivityPage, ActivityQuery } from '../domain/activity.js';

export interface ActivityStore {
  /** Reads a bounded page with immutable IDs; administrative events require a fresh owner/admin context. */
  list(context: TenantContext, query: ActivityQuery): Promise<ActivityPage>;
}

/** Refreshes membership before every history read, including cursor requests. */
export function createActivityService(
  store: ActivityStore,
  refreshContext: (context: TenantContext) => Promise<TenantContext>,
) {
  return async (context: TenantContext, query: ActivityQuery) => {
    const fresh = await refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Actor changed');

    return store.list(fresh, query);
  };
}

export type ActivityService = ReturnType<typeof createActivityService>;
