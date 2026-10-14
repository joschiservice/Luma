import {
  type CollectionGroup,
  type CollectionViewState,
  type FulfillmentQueryInput,
  fulfillmentSortSchema,
  type FulfillmentView,
  fulfillmentViewSchema,
} from '@luma/api-contract';
import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { withLegacyConditions } from '../../kit/collections/legacy';
import { collectionSearchShape, groupOf } from '../../kit/collections/state';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import {
  legacyFulfillmentConditions,
  type LegacyFulfillmentSearch,
} from './collection';

const api = createWebApiClient();

/**
 * Filters of links from before configurable views, such as Insights drill-downs. The route
 * converts them into conditions; `recent`, the old newest-progress sort, becomes the
 * last-progress sort in descending order.
 */
const legacyShape = {
  connectionId: z.uuid().optional().catch(undefined),
  locationId: z.uuid().optional().catch(undefined),
  kind: z.enum(['fulfillment_order', 'shipment']).optional().catch(undefined),
};

const legacyKeys = Object.keys(
  legacyShape,
) as (keyof LegacyFulfillmentSearch)[];

/** Page context besides the view: the fulfillment open in the preview and where the reader came from. */
const contextShape = {
  item: z.uuid().optional().catch(undefined),
  from: z.string().max(2048).optional().catch(undefined),
};

/**
 * URL state of the Fulfillment list and fulfillment pages: the shared list keys (view,
 * conditions, sort, grouping, display, search and paging), filters of older links and page
 * context.
 */
export const fulfillmentSearch = z.object({
  ...collectionSearchShape,
  ...legacyShape,
  ...contextShape,
});

export type FulfillmentSearch = z.infer<typeof fulfillmentSearch>;

export const fulfillmentPageSize = 50;

/** Rows each group shows before "Show more", and the size of each further page. */
const fulfillmentGroupPageSize = 10;

/** Whether the URL still uses filters or the sort of older links. */
export function hasLegacyFilters(search: FulfillmentSearch) {
  return (
    legacyKeys.some((key) => search[key] !== undefined) ||
    search.sort === 'recent'
  );
}

/**
 * Rewrites older filter keys into conditions, merged with the URL's own conditions, and starts
 * from the first page because a cursor binds the filters it was read with.
 */
export function withoutLegacyFilters(
  search: FulfillmentSearch,
): FulfillmentSearch {
  const conditions = legacyFulfillmentConditions(search);
  const next: FulfillmentSearch = { ...search };
  for (const key of legacyKeys) delete next[key];
  delete next.cursor;
  delete next.page;
  if (search.sort === 'recent') {
    next.sort = 'waiting';
    next.direction = 'desc';
  }

  return conditions.length
    ? { ...next, where: withLegacyConditions(search.where, conditions) }
    : next;
}

/** Whether the URL says what to show, so the page must not restore the remembered view. */
export function namesListState(search: FulfillmentSearch) {
  return Boolean(
    search.q || search.cursor || search.page || search.item || search.from,
  );
}

/** Returns the list state without paging and page context, so the list starts on page one. */
export function fulfillmentFilters(
  search: FulfillmentSearch,
): FulfillmentSearch {
  const filters = { ...search };
  delete filters.cursor;
  delete filters.page;
  delete filters.item;
  delete filters.from;

  return filters;
}

const sorts = new Set<string>(fulfillmentSortSchema.options);
const views = new Set<string>(fulfillmentViewSchema.options);

/**
 * Builds the list request for a view: its built-in segment, conditions (sent only when there
 * are any), sort with its direction and grouping, with search text and the page cursor.
 * Grouped reads return each group's first rows and take no page cursor; `group` reads one
 * group's next page instead. Calendar conditions and date groups follow `timeZone`, the
 * workspace's time zone.
 */
export function fulfillmentListQuery(
  state: CollectionViewState,
  search: Pick<FulfillmentSearch, 'q' | 'cursor'>,
  timeZone: string,
  group?: { key: CollectionGroup['key']; cursor: string },
): FulfillmentQueryInput {
  const grouping = groupOf(state);
  const field = state.sort?.field;

  return {
    q: search.q?.trim() ?? '',
    view:
      state.segment && views.has(state.segment)
        ? (state.segment as FulfillmentView)
        : 'attention',
    ...(state.where.conditions.length
      ? { where: JSON.stringify(state.where) }
      : {}),
    sort:
      field && sorts.has(field)
        ? (field as FulfillmentQueryInput['sort'])
        : 'waiting',
    ...(state.sort ? { direction: state.sort.direction } : {}),
    timeZone,
    ...(grouping
      ? group
        ? {
            group: grouping,
            groupKey: JSON.stringify(group.key),
            cursor: group.cursor,
            limit: fulfillmentPageSize,
          }
        : { group: grouping, groupLimit: fulfillmentGroupPageSize }
      : { limit: fulfillmentPageSize, cursor: search.cursor }),
  };
}

/** Loads one page of fulfillments, or a grouped read, with per-view counts. */
export function fulfillmentListOptions(
  organizationId: string,
  query: FulfillmentQueryInput,
) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'fulfillment', query],
    refetchOnReconnect: 'always',
    // A changed filter keeps the previous rows visible until the new ones arrive.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api.fulfillment.list({ params: { organizationId }, query }, { signal }),
  });
}

/**
 * Loads a built-in view's first rows with per-view counts, sources and locations, for summaries
 * such as Home and the location options of other lists.
 */
export function fulfillmentsOptions(
  organizationId: string,
  search: { view?: FulfillmentView | undefined },
  limit?: number,
) {
  return fulfillmentListOptions(organizationId, {
    q: '',
    view: search.view ?? 'attention',
    sort: 'waiting',
    ...(limit ? { limit } : {}),
  });
}

/** Loads one fulfillment with its evidence, order, related work and linked records. */
export function fulfillmentOptions(
  organizationId: string,
  fulfillmentId: string,
) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: [
      'private',
      'organization',
      organizationId,
      'fulfillment-detail',
      fulfillmentId,
    ],
    refetchOnReconnect: 'always',
    queryFn: ({ signal }) =>
      api.fulfillment.get(
        { params: { organizationId, fulfillmentId } },
        { signal },
      ),
  });
}
