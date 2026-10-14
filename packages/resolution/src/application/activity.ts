import type { TenantContext } from '@luma/identity';
import {
  IdentityError,
  requirePermission,
  requireTenant,
} from '@luma/identity';

import type { ActivityPage, ActivityQuery } from '../domain/activity.js';

export interface ActivityStore {
  /**
   * Reads a bounded page with immutable IDs. Connection and access events need
   * `activity.read_restricted` on the supplied fresh context.
   */
  list(context: TenantContext, query: ActivityQuery): Promise<ActivityPage>;
}

/**
 * Replaces `me` in an actor filter with the reader's user ID and drops repeated values, so a
 * shared saved view names each reader's own events.
 */
export function resolveActivityActors(
  actor: readonly string[] | undefined,
  readerId: string,
): string[] | undefined {
  if (!actor) return undefined;

  return [
    ...new Set(actor.map((value) => (value === 'me' ? readerId : value))),
  ].sort();
}

/**
 * Refreshes membership before every history read, including cursor requests; requires
 * `activity.read`. Filters only narrow the events the reader may see: restricted events still
 * need `activity.read_restricted`, whatever the actor filter names.
 */
export function createActivityService(
  store: ActivityStore,
  refreshContext: (context: TenantContext) => Promise<TenantContext>,
) {
  return async (context: TenantContext, query: ActivityQuery) => {
    const fresh = await refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Actor changed');
    requirePermission(fresh, 'activity.read');
    const actor = resolveActivityActors(query.actor, fresh.actor.id);

    return store.list(fresh, { ...query, ...(actor ? { actor } : {}) });
  };
}

export type ActivityService = ReturnType<typeof createActivityService>;
