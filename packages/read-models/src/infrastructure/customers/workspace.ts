import type { TenantContext } from '@luma/identity';
import { hasPermission, requirePermission } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import type { CollectionGroupKey } from '../../application/collections.js';
import type {
  CustomerListItem,
  CustomerWorkspace,
} from '../../application/customers.js';
import {
  collectionCursorContext,
  readCollectionCursor,
  writeCollectionCursor,
} from '../collection/cursor.js';
import { groupResults } from '../collection/group.js';
import { collectionScope, maxCollectionGroups } from '../collection/request.js';
import { customerFieldPermissions } from './collection-fields.js';
import { readCustomer, readCustomers, readCustomerSources } from './list.js';

const badRequest = (message: string) =>
  Object.assign(new Error(message), { statusCode: 400, expose: true });

/** Leaves out the last order date for readers who cannot read orders. */
function visible(context: TenantContext) {
  const orders = hasPermission(context, 'orders.read');

  return (item: CustomerListItem): CustomerListItem => {
    if (orders) return item;
    const hidden = { ...item };
    delete hidden.lastOrderAt;

    return hidden;
  };
}

/**
 * Creates tenant-scoped reads of imported customer profiles in a consistent database snapshot.
 * List cursors are bound to the tenant, search, filters, conditions, grouping and sort.
 */
export function createCustomerWorkspace(db: TenantDatabase): CustomerWorkspace {
  return {
    async list(context, query) {
      requirePermission(context, 'customers.read');
      if (query.externalId && !query.connectionId)
        throw badRequest('Choose the source of this customer ID.');
      // Gated catalog fields answer 403, including as the sort.
      for (const field of [
        ...(query.where?.conditions.map((condition) => condition.field) ?? []),
        ...(query.group ? [query.group.field] : []),
        query.sort,
      ])
        for (const permission of Object.hasOwn(customerFieldPermissions, field)
          ? (customerFieldPermissions[field] ?? [])
          : [])
          requirePermission(context, permission);
      const scope = (key?: CollectionGroupKey) =>
        collectionCursorContext(
          'customers-v3',
          context.tenantId,
          collectionScope(query, key),
        );
      const after = query.cursor
        ? readCollectionCursor(
            query.cursor,
            scope(query.groupKey),
            'This page link no longer matches the customer filters. Start from the first page.',
          )
        : null;
      const asOf = new Date().toISOString();
      const show = visible(context);

      return db.transaction(
        context.tenantId,
        async (tx) => {
          const page = await readCustomers(tx, context, query, asOf, after);
          const sources = await readCustomerSources(tx, context.tenantId);
          // Group counts may miss profiles while a source still imports its customers.
          const complete = !sources.some((source) => source.importing);
          const grouped =
            query.group !== undefined && query.groupKey === undefined;
          const rows = grouped ? page.rows : page.rows.slice(0, query.limit);
          const last = rows.at(-1);
          const nextCursor =
            !grouped && page.rows.length > query.limit && last
              ? writeCollectionCursor(scope(query.groupKey), last.position)
              : null;
          const grouping =
            grouped && page.groups
              ? groupResults(
                  page.groups,
                  maxCollectionGroups,
                  complete,
                  (key, position) =>
                    writeCollectionCursor(scope(key), position),
                )
              : undefined;

          return {
            items: rows.map((row) => show(row.item)),
            sources,
            totalCount: page.totalCount,
            nextCursor,
            ...(grouping
              ? { groups: grouping.groups, groupsTruncated: grouping.truncated }
              : query.groupKey !== undefined
                ? {
                    groups: [
                      {
                        key: query.groupKey,
                        count: page.totalCount,
                        complete,
                        itemIds: rows.map((row) => row.item.id),
                        nextCursor,
                        sums: [],
                      },
                    ],
                  }
                : {}),
            asOf,
          };
        },
        { readOnlySnapshot: true },
      );
    },
    async get(context, id) {
      requirePermission(context, 'customers.read');
      const show = visible(context);

      return db.transaction(
        context.tenantId,
        async (tx) => {
          const profile = await readCustomer(tx, context.tenantId, id);
          if (!profile) return null;
          const [source] = await readCustomerSources(
            tx,
            context.tenantId,
            profile.item.connectionId,
          );

          return {
            ...profile,
            item: show(profile.item),
            source: source ?? null,
            asOf: new Date().toISOString(),
          };
        },
        { readOnlySnapshot: true },
      );
    },
  };
}
