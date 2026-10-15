import type { TenantContext } from '@luma/identity';
import {
  IdentityError,
  requireChangesAllowed,
  requirePermission,
  requireTenant,
} from '@luma/identity';

import type {
  ActivityCounts,
  ActivityPage,
  ActivityQuery,
} from '../domain/activity.js';
import {
  activityCsv,
  type ActivityExportLabels,
  activityExportRowLimit,
} from '../domain/activity-export.js';

export interface ActivityStore {
  /**
   * Reads a bounded page with immutable IDs, or with `event` the one group holding that event.
   * Connection and access events need `activity.read_restricted` on the supplied fresh context.
   */
  list(context: TenantContext, query: ActivityQuery): Promise<ActivityPage>;
  /** Counts business groups by outcome under the query's filters, ignoring its outcome. */
  counts(context: TenantContext, query: ActivityQuery): Promise<ActivityCounts>;
}

/** What an activity export records in the audit log; the exported values are not stored. */
export interface ActivityExportRecord {
  id: string;
  tenantId: string;
  actorId: string;
  occurredAt: string;
  rows: number;
  truncated: boolean;
  /** How many filters narrowed the export, besides the date range. */
  filters: number;
}

/** Records exports; without it the service refuses to export. */
export interface ActivityExportLog {
  record(context: TenantContext, entry: ActivityExportRecord): Promise<void>;
  id(): string;
  now(): Date;
}

/** The filters of an export: a list query without paging, grouping or detail. */
export type ActivityExportQuery = Omit<
  ActivityQuery,
  'view' | 'detail' | 'event' | 'limit' | 'cursor' | 'subjects'
>;

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
 * Refreshes membership before every history read, including cursor requests, counts and
 * exports; requires `activity.read`. Filters only narrow the events the reader may see:
 * restricted events still need `activity.read_restricted`, whatever the actor filter names.
 */
export function createActivityService(
  store: ActivityStore,
  refreshContext: (context: TenantContext) => Promise<TenantContext>,
  exports?: ActivityExportLog,
) {
  const reader = async (context: TenantContext) => {
    const fresh = await refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Actor changed');
    requirePermission(fresh, 'activity.read');

    return fresh;
  };
  const resolved = <Query extends { actor?: readonly string[] | undefined }>(
    query: Query,
    fresh: TenantContext,
  ) => {
    const actor = resolveActivityActors(query.actor, fresh.actor.id);

    return { ...query, ...(actor ? { actor } : {}) };
  };

  return {
    async list(context: TenantContext, query: ActivityQuery) {
      const fresh = await reader(context);

      return store.list(fresh, resolved(query, fresh));
    },

    async counts(context: TenantContext, query: ActivityQuery) {
      const fresh = await reader(context);

      return store.counts(fresh, resolved(query, fresh));
    },

    /**
     * Exports every recorded event that matches the filters as CSV, newest first and cut off
     * after the export limit. Needs `lists.export` as well, and refuses read-only support views.
     * Each export is recorded without its values.
     */
    async export(
      context: TenantContext,
      query: ActivityExportQuery,
      labels: ActivityExportLabels,
    ) {
      const fresh = await reader(context);
      requireChangesAllowed(fresh);
      requirePermission(fresh, 'lists.export');
      if (!exports)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Activity export is unavailable',
        );
      const page = await store.list(fresh, {
        ...resolved(query, fresh),
        view: 'events',
        detail: 'summary',
        limit: activityExportRowLimit,
      });
      const truncated = page.nextCursor !== null;
      const id = exports.id();
      const occurredAt = exports.now().toISOString();
      await exports.record(fresh, {
        id,
        tenantId: fresh.tenantId,
        actorId: fresh.actor.id,
        occurredAt,
        rows: page.items.length,
        truncated,
        filters: [
          query.q,
          query.system,
          query.connectionId,
          query.type,
          query.outcome?.length,
          query.actor?.length,
        ].filter(Boolean).length,
      });

      return {
        filename: `activity-${occurredAt.slice(0, 10)}.csv`,
        csv: activityCsv(page.items, labels, truncated),
        rows: page.items.length,
        truncated,
      };
    },
  };
}

export type ActivityService = ReturnType<typeof createActivityService>;
