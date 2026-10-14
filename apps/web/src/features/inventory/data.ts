import {
  type CollectionGroup,
  type CollectionViewState,
  inventoryQuerySchema,
  transferQuerySchema,
} from '@luma/api-contract';
import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { anyOf, withLegacyConditions } from '../../kit/collections/legacy';
import { collectionSearchShape, groupOf } from '../../kit/collections/state';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

const api = createWebApiClient();

/** The inventory list query as clients send it: conditions and group keys are JSON text. */
export type InventoryQueryInput = z.input<typeof inventoryQuerySchema>;

/** The transfers list query as clients send it: conditions are JSON text. */
export type TransferQueryInput = z.input<typeof transferQuerySchema>;

/** Location and source filters of links from before configurable views. */
const legacyShape = {
  locationId: z.uuid().optional().catch(undefined),
  connectionId: z.uuid().optional().catch(undefined),
};

const legacyKeys = Object.keys(legacyShape) as (keyof typeof legacyShape)[];

/**
 * Page context besides the view: one SKU's positions across locations (links from products,
 * orders and stock detail), the position open in the preview and where the reader came from.
 */
const contextShape = {
  skuId: z.uuid().optional().catch(undefined),
  item: z.uuid().optional().catch(undefined),
  from: z.string().max(2048).optional().catch(undefined),
};

/**
 * URL state of the Inventory list and stock pages: the shared list keys (view, conditions,
 * sort, grouping, display, search and paging), filters of older links and page context.
 */
export const inventorySearch = z.object({
  ...collectionSearchShape,
  cursor: z.string().max(1024).optional().catch(undefined),
  ...legacyShape,
  ...contextShape,
});

export type InventorySearch = z.infer<typeof inventorySearch>;

export const inventoryPageSize = 50;

/** Rows each group shows before "Show more", and the size of each further page. */
const inventoryGroupPageSize = 10;

/** Whether the URL still uses location or source filters of older links. */
export function hasLegacyFilters(search: InventorySearch) {
  return legacyKeys.some((key) => search[key] !== undefined);
}

/**
 * Rewrites location and source filters of older links into the same conditions, merged with
 * the URL's own, and starts from the first page because a cursor binds its filters.
 */
export function withoutLegacyFilters(search: InventorySearch): InventorySearch {
  const conditions = [
    ...(search.locationId ? [anyOf('location', search.locationId)] : []),
    ...(search.connectionId ? [anyOf('source', search.connectionId)] : []),
  ];
  const next: InventorySearch = { ...search };
  for (const key of legacyKeys) delete next[key];
  delete next.cursor;
  delete next.page;

  return conditions.length
    ? { ...next, where: withLegacyConditions(search.where, conditions) }
    : next;
}

/** Whether the URL says what to show, so the page must not restore the remembered view. */
export function namesListState(search: InventorySearch) {
  return Boolean(
    search.q ||
    search.cursor ||
    search.page ||
    search.skuId ||
    search.item ||
    search.from,
  );
}

/** Returns the list state without paging and page context, so the list starts on page one. */
export function inventoryFilters(search: InventorySearch): InventorySearch {
  const filters = { ...search };
  delete filters.cursor;
  delete filters.page;
  delete filters.item;
  delete filters.from;

  return filters;
}

const sorts = new Set<string>(inventoryQuerySchema.shape.sort.unwrap().options);
const views = new Set<string>(inventoryQuerySchema.shape.view.unwrap().options);

/**
 * Builds the list request for a view: its built-in segment, conditions (sent only when there
 * are any), sort with its direction and grouping, with search text, the SKU context and the
 * page cursor. Grouped reads return each group's first positions and take no page cursor;
 * `group` reads one group's next page instead. Pages ask for the exact count, which the read
 * knows anyway because every sort orders all matching positions.
 */
export function inventoryListQuery(
  state: CollectionViewState,
  search: Pick<InventorySearch, 'q' | 'cursor' | 'skuId'>,
  timeZone: string,
  group?: { key: CollectionGroup['key']; cursor: string },
): InventoryQueryInput {
  const grouping = groupOf(state);
  const field = state.sort?.field;

  return {
    q: search.q?.trim() ?? '',
    view:
      state.segment && views.has(state.segment)
        ? (state.segment as InventoryQueryInput['view'])
        : 'all',
    ...(search.skuId ? { skuId: search.skuId } : {}),
    ...(state.where.conditions.length
      ? { where: JSON.stringify(state.where) }
      : {}),
    sort:
      field && sorts.has(field)
        ? (field as InventoryQueryInput['sort'])
        : 'sku',
    direction: state.sort?.direction ?? 'asc',
    timeZone,
    ...(grouping
      ? group
        ? {
            group: grouping,
            groupKey: JSON.stringify(group.key),
            cursor: group.cursor,
            limit: inventoryPageSize,
          }
        : { group: grouping, groupLimit: inventoryGroupPageSize }
      : {
          limit: inventoryPageSize,
          count: 'exact' as const,
          cursor: search.cursor,
        }),
  };
}

/** Loads one page of stock positions, or a grouped read. */
export function inventoryListOptions(
  organizationId: string,
  query: InventoryQueryInput,
) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'inventory', query],
    refetchOnReconnect: 'always',
    // A changed filter keeps the previous rows visible until the new ones arrive.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api.inventory.list({ params: { organizationId }, query }, { signal }),
  });
}

/**
 * Loads the first page of stock positions narrowed to a SKU, location or source, for places
 * outside the list such as an order line's stock.
 */
export function inventoryOptions(
  organizationId: string,
  filters: Pick<InventorySearch, 'skuId' | 'locationId' | 'connectionId'>,
) {
  return inventoryListOptions(organizationId, {
    q: '',
    view: 'all',
    ...(filters.skuId ? { skuId: filters.skuId } : {}),
    ...(filters.locationId ? { locationId: filters.locationId } : {}),
    ...(filters.connectionId ? { connectionId: filters.connectionId } : {}),
  });
}

/**
 * Lists the locations that hold stock positions, with their names, for the location picker. One
 * grouped read returns every location (up to the group limit) with one position each.
 */
export function inventoryLocationsOptions(organizationId: string) {
  const query: InventoryQueryInput = {
    q: '',
    view: 'all',
    group: 'location',
    groupLimit: 1,
  };

  return queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'inventory', query],
    refetchOnReconnect: 'always',
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }) => {
      const list = await api.inventory.list(
        { params: { organizationId }, query },
        { signal },
      );
      const names = new Map(
        list.items.map((item) => [item.locationId, item.location]),
      );

      return (list.groups ?? []).flatMap((group) =>
        typeof group.key === 'string'
          ? [{ value: group.key, label: names.get(group.key) ?? group.key }]
          : [],
      );
    },
  });
}

/** Loads source quantities, observation history and related work for one stock position. */
export function stockOptions(organizationId: string, positionId: string) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'stock', positionId],
    refetchOnReconnect: 'always',
    queryFn: ({ signal }) =>
      api.inventory.get({ params: { organizationId, positionId } }, { signal }),
  });
}

/** The source filter of transfer links from before configurable views. */
const transferLegacyShape = {
  connectionId: z.uuid().optional().catch(undefined),
  kind: z
    .enum(['inventory_transfer', 'inventory_shipment'])
    .optional()
    .catch(undefined),
};

/**
 * URL state of the Transfers list: the shared list keys, a source filter and record kind of
 * older links, and one SKU's or location's records as page context, as stock detail links them.
 */
export const transferSearch = z.object({
  ...collectionSearchShape,
  cursor: z.string().max(1024).optional().catch(undefined),
  ...transferLegacyShape,
  skuId: z.uuid().optional().catch(undefined),
  locationId: z.uuid().optional().catch(undefined),
});

export type TransferSearch = z.infer<typeof transferSearch>;

export const transferPageSize = 50;

/** Whether the URL still uses the source filter or record kind of older links. */
export function hasLegacyTransferFilters(search: TransferSearch) {
  return search.connectionId !== undefined || search.kind !== undefined;
}

/**
 * Rewrites the older source filter into a condition and the record kind into its built-in view,
 * starting from the first page.
 */
export function withoutLegacyTransferFilters(
  search: TransferSearch,
): TransferSearch {
  const next: TransferSearch = { ...search };
  delete next.connectionId;
  delete next.kind;
  delete next.cursor;
  delete next.page;
  if (search.kind && !search.view) next.view = search.kind;

  return search.connectionId
    ? {
        ...next,
        where: withLegacyConditions(search.where, [
          anyOf('source', search.connectionId),
        ]),
      }
    : next;
}

/** Whether the URL says what to show, so the page must not restore the remembered view. */
export function namesTransferState(search: TransferSearch) {
  return Boolean(
    search.q ||
    search.cursor ||
    search.page ||
    search.skuId ||
    search.locationId,
  );
}

const transferSorts = new Set<string>(
  transferQuerySchema.shape.sort.unwrap().options,
);
const transferKinds = new Set<string>(
  transferQuerySchema.shape.kind.unwrap().options,
);

/**
 * Builds the transfers request for a view: its record kind, conditions (sent only when there
 * are any), sort with its direction (newest requests first without one), search text, SKU or
 * location context and the page cursor.
 */
export function transferListQuery(
  state: CollectionViewState,
  search: Pick<TransferSearch, 'q' | 'cursor' | 'skuId' | 'locationId'>,
  timeZone: string,
): TransferQueryInput {
  const field = state.sort?.field;

  return {
    kind:
      state.segment && transferKinds.has(state.segment)
        ? (state.segment as TransferQueryInput['kind'])
        : 'inventory_transfer',
    q: search.q?.trim() ?? '',
    ...(search.skuId ? { skuId: search.skuId } : {}),
    ...(search.locationId ? { locationId: search.locationId } : {}),
    ...(state.where.conditions.length
      ? { where: JSON.stringify(state.where) }
      : {}),
    sort:
      field && transferSorts.has(field)
        ? (field as TransferQueryInput['sort'])
        : 'requested',
    direction: state.sort?.direction ?? 'desc',
    timeZone,
    limit: transferPageSize,
    count: 'exact',
    cursor: search.cursor,
  };
}

/** Reads bounded transfer summaries and reevaluates freshness on reconnect and once a minute. */
export function transfersOptions(
  organizationId: string,
  query: TransferQueryInput,
) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'transfers', query],
    refetchOnReconnect: 'always',
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api.inventory.transfers(
        { params: { organizationId }, query },
        { signal },
      ),
  });
}

/** Reads a single source projection with exact relationships and retained observed history. */
export function transferOptions(
  organizationId: string,
  transferId: string,
  connectionId: string,
) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: [
      'private',
      'organization',
      organizationId,
      'transfer',
      transferId,
      connectionId,
    ],
    refetchOnReconnect: 'always',
    refetchInterval: 60_000,
    queryFn: ({ signal }) =>
      api.inventory.transfer(
        { params: { organizationId, transferId, connectionId } },
        { signal },
      ),
  });
}
