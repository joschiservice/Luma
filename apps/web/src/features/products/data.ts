import {
  type CollectionGroup,
  type CollectionViewState,
  productQuerySchema,
  productSortSchema,
} from '@luma/api-contract';
import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { anyOf, withLegacyConditions } from '../../kit/collections/legacy';
import { collectionSearchShape, groupOf } from '../../kit/collections/state';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

const api = createWebApiClient();

/** The products list query as clients send it: conditions and group keys are JSON text. */
export type ProductQueryInput = z.input<typeof productQuerySchema>;

/** Source filters of links from before configurable views; the route converts them into conditions. */
const legacyShape = {
  connectionId: z.uuid().optional().catch(undefined),
  missingFrom: z.uuid().optional().catch(undefined),
};

const legacyKeys = Object.keys(legacyShape) as (keyof typeof legacyShape)[];

/** Page context besides the view: the SKU open in the preview and where the reader came from. */
const contextShape = {
  item: z.uuid().optional().catch(undefined),
  from: z.string().max(2048).optional().catch(undefined),
};

/**
 * URL state of the Products list and product pages: the shared list keys (view, conditions,
 * sort, grouping, display, search and paging), filters of older links and page context.
 */
export const productsSearch = z.object({
  ...collectionSearchShape,
  ...legacyShape,
  ...contextShape,
});

export type ProductsSearch = z.infer<typeof productsSearch>;

export const productPageSize = 50;

/** Rows each group shows before "Show more", and the size of each further page. */
const productGroupPageSize = 10;

/** Whether the URL still uses source filters of older links. */
export function hasLegacyFilters(search: ProductsSearch) {
  return legacyKeys.some((key) => search[key] !== undefined);
}

/**
 * Rewrites "Listed in" and "Missing from" filters of older links into the same conditions,
 * merged with the URL's own, and starts from the first page because a cursor binds its filters.
 */
export function withoutLegacyFilters(search: ProductsSearch): ProductsSearch {
  const conditions = [
    ...(search.connectionId ? [anyOf('listings', search.connectionId)] : []),
    ...(search.missingFrom ? [anyOf('missing', search.missingFrom)] : []),
  ];
  const next: ProductsSearch = { ...search };
  for (const key of legacyKeys) delete next[key];
  delete next.cursor;
  delete next.page;

  return conditions.length
    ? { ...next, where: withLegacyConditions(search.where, conditions) }
    : next;
}

/** Whether the URL says what to show, so the page must not restore the remembered view. */
export function namesListState(search: ProductsSearch) {
  return Boolean(
    search.q || search.cursor || search.page || search.item || search.from,
  );
}

/** Returns the list state without paging and page context, so the list starts on page one. */
export function productFilters(search: ProductsSearch): ProductsSearch {
  const filters = { ...search };
  delete filters.cursor;
  delete filters.page;
  delete filters.item;
  delete filters.from;

  return filters;
}

const sorts = new Set<string>(productSortSchema.options);
const views = new Set<string>(
  productQuerySchema.shape.view.unwrap().options as readonly string[],
);

/** The API's sort for a view's sort field; the server checks that a custom field is readable. */
function apiSort(field: string | undefined): ProductQueryInput['sort'] {
  if (field && sorts.has(field)) return field as ProductQueryInput['sort'];
  if (field && /^custom:[0-9a-f-]{36}$/.test(field))
    return field as `custom:${string}`;

  return 'rank';
}

/**
 * Builds the list request for a view: its built-in segment, conditions (sent only when there
 * are any), sort (a catalog or custom field) with its direction (the catalog order without
 * one) and grouping, with search text and the page cursor. Grouped reads return each group's
 * first SKUs and take no page cursor; `group` reads one group's next page instead.
 */
export function productListQuery(
  state: CollectionViewState,
  search: Pick<ProductsSearch, 'q' | 'cursor'>,
  timeZone: string,
  group?: { key: CollectionGroup['key']; cursor: string },
): ProductQueryInput {
  const grouping = groupOf(state);
  const field = state.sort?.field;

  return {
    q: search.q?.trim() ?? '',
    view:
      state.segment && views.has(state.segment)
        ? (state.segment as ProductQueryInput['view'])
        : 'all',
    ...(state.where.conditions.length
      ? { where: JSON.stringify(state.where) }
      : {}),
    sort: apiSort(field),
    direction: state.sort?.direction ?? 'asc',
    timeZone,
    ...(grouping
      ? group
        ? {
            group: grouping,
            groupKey: JSON.stringify(group.key),
            cursor: group.cursor,
            limit: productPageSize,
          }
        : { group: grouping, groupLimit: productGroupPageSize }
      : { limit: productPageSize, cursor: search.cursor }),
  };
}

/** Loads a page of catalog SKUs, or a grouped read, with per-view counts. */
export function productsOptions(
  organizationId: string,
  query: ProductQueryInput,
) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'products', query],
    refetchOnReconnect: 'always',
    // A changed filter keeps the previous rows visible until the new ones arrive.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api.products.list({ params: { organizationId }, query }, { signal }),
  });
}

/** Loads one SKU's listings by source and everything that depends on it. */
export function productOptions(organizationId: string, skuId: string) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'product', skuId],
    refetchOnReconnect: 'always',
    queryFn: ({ signal }) =>
      api.products.get({ params: { organizationId, skuId } }, { signal }),
  });
}

/** Loads only the catalog sources and per-view counts, for summaries such as Home. */
export function productSummaryOptions(organizationId: string) {
  const query: ProductQueryInput = { q: '', view: 'all', limit: 1 };

  return queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'products', query],
    refetchOnReconnect: 'always',
    queryFn: ({ signal }) =>
      api.products.list({ params: { organizationId }, query }, { signal }),
  });
}
