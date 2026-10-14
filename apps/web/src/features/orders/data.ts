import {
  type CollectionGroup,
  type CollectionViewState,
  type OrderChangePlanQuery,
  type OrderListQueryInput,
  orderSortSchema,
  orderViewSchema,
} from '@luma/api-contract';
import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { collectionSearchShape, groupOf } from '../../kit/collections/state';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import {
  legacyOrderConditions,
  type LegacyOrderSearch,
  withLegacyConditions,
} from './collection';

const api = createWebApiClient();

export const orderStatuses = [
  'open',
  'completed',
  'cancelled',
  'unknown',
] as const;

const orderPaymentStatuses = [
  'pending',
  'authorized',
  'paid',
  'partially_refunded',
  'refunded',
  'failed',
  'unknown',
] as const;

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value,
  );

/**
 * Filters of links from before configurable views. The route converts them into conditions:
 * placed bounds are workspace calendar days, updated bounds exact instants from metric
 * drill-downs.
 */
const legacyShape = {
  status: z.enum(orderStatuses).optional().catch(undefined),
  paymentStatus: z.enum(orderPaymentStatuses).optional().catch(undefined),
  connectionId: z.uuid().optional().catch(undefined),
  placedFrom: day.optional().catch(undefined),
  placedTo: day.optional().catch(undefined),
  updatedFrom: z.iso.datetime().optional().catch(undefined),
  updatedBefore: z.iso.datetime().optional().catch(undefined),
};

const legacyKeys = Object.keys(legacyShape) as (keyof LegacyOrderSearch)[];

/** Page context the Orders pages carry besides the view: where the reader came from and plans. */
const contextShape = {
  /** The order open in the preview pane. */
  item: z.uuid().optional().catch(undefined),
  linkedFrom: z.uuid().optional().catch(undefined),
  from: z.string().max(2048).optional().catch(undefined),
  /** A proposed quantity change to plan: the line's comparison key and its new quantity. */
  changeLine: z.uuid().optional().catch(undefined),
  changeQuantity: z
    .string()
    .regex(/^\d{1,14}(\.\d{1,6})?$/)
    .optional()
    .catch(undefined),
  /** The connection whose app should open its edit, prefilled from the plan's Luma step. */
  edit: z.uuid().optional().catch(undefined),
};

/**
 * URL state of the Orders list and order pages: the shared list keys (view, conditions, sort,
 * grouping, display and paging), filters of older links and page context. `q` only arrives
 * with links, such as a product's orders: search can match customer data, so the page moves
 * it into page state and removes it from the address.
 */
export const ordersSearch = z.object({
  ...collectionSearchShape,
  ...legacyShape,
  ...contextShape,
});

export type OrdersSearch = z.infer<typeof ordersSearch>;

export const orderPageSize = 50;

/** Rows each group shows before "Show more", and the size of each further page. */
const orderGroupPageSize = 10;

/** Whether the URL still uses filters of older links. */
export function hasLegacyFilters(search: OrdersSearch) {
  return legacyKeys.some((key) => search[key] !== undefined);
}

/**
 * Rewrites older filter keys into conditions, merged with the URL's own conditions, and starts
 * from the first page because a cursor binds the filters it was read with.
 */
export function withoutLegacyFilters(search: OrdersSearch): OrdersSearch {
  const conditions = legacyOrderConditions(search);
  const next: OrdersSearch = { ...search };
  for (const key of legacyKeys) delete next[key];
  delete next.cursor;
  delete next.page;

  return conditions.length
    ? { ...next, where: withLegacyConditions(search.where, conditions) }
    : next;
}

/** Whether the URL says what to show, so the page must not restore the remembered view. */
export function namesListState(search: OrdersSearch) {
  return Boolean(
    search.q ||
    search.cursor ||
    search.page ||
    search.item ||
    search.from ||
    search.linkedFrom ||
    search.changeLine ||
    search.changeQuantity ||
    search.edit,
  );
}

/** Returns the list state without paging and page context, so the list starts on page one. */
export function orderFilters(search: OrdersSearch): OrdersSearch {
  const filters = { ...search };
  delete filters.cursor;
  delete filters.page;
  delete filters.item;
  delete filters.from;
  delete filters.linkedFrom;
  delete filters.changeLine;
  delete filters.changeQuantity;
  delete filters.edit;

  return filters;
}

const sorts = new Set<string>(orderSortSchema.options);
const views = new Set<string>(orderViewSchema.options);

/**
 * Builds the list request for a view: its built-in segment, conditions (sent only when there
 * are any), sort (a catalog field or a custom field) and grouping, with search text and the page cursor. Grouped reads return each
 * group's first rows and take no page cursor; `group` reads one group's next page instead.
 * Calendar conditions and date groups follow `timeZone`, the workspace's time zone.
 */
export function orderListQuery(
  state: CollectionViewState,
  search: Pick<OrdersSearch, 'q' | 'cursor'>,
  timeZone: string,
  group?: { key: CollectionGroup['key']; cursor: string },
): OrderListQueryInput {
  const grouping = groupOf(state);
  const field = state.sort?.field;
  // Catalog sorts and custom fields go through; the server checks the custom field.
  const sort: OrderListQueryInput['sort'] =
    field && sorts.has(field)
      ? (field as OrderListQueryInput['sort'])
      : field && /^custom:[0-9a-f-]{36}$/.test(field)
        ? (field as `custom:${string}`)
        : 'updated';

  return {
    q: search.q?.trim() ?? '',
    view:
      state.segment && views.has(state.segment)
        ? (state.segment as OrderListQueryInput['view'])
        : 'all',
    ...(state.where.conditions.length
      ? { where: JSON.stringify(state.where) }
      : {}),
    sort,
    direction: state.sort?.direction ?? 'desc',
    timeZone,
    ...(grouping
      ? group
        ? {
            group: grouping,
            groupKey: JSON.stringify(group.key),
            cursor: group.cursor,
            limit: orderPageSize,
          }
        : { group: grouping, groupLimit: orderGroupPageSize }
      : { limit: orderPageSize, cursor: search.cursor }),
  };
}

/** Loads one page of current orders, or a grouped read, for the active workspace. */
export function ordersOptions(
  organizationId: string,
  query: OrderListQueryInput,
) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'orders', query],
    refetchOnReconnect: 'always',
    // A changed filter keeps the previous rows visible until the new ones arrive.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api.orders.list({ params: { organizationId }, query }, { signal }),
  });
}

/** Loads one order with its source facts, evidence and linked work. */
export function orderOptions(organizationId: string, orderId: string) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'order', orderId],
    refetchOnReconnect: 'always',
    queryFn: ({ signal }) =>
      api.orders.get({ params: { organizationId, orderId } }, { signal }),
  });
}

/** A proposed quantity change from the order URL, or null to plan detected changes. */
export function proposedChange(
  search: OrdersSearch,
): OrderChangePlanQuery | null {
  return search.changeLine && search.changeQuantity !== undefined
    ? {
        kind: 'quantity',
        lineKey: search.changeLine,
        quantity: search.changeQuantity,
      }
    : null;
}

/**
 * Plans the proposed change, or the detected ones, for one order. `asOf` is the order detail's
 * read time, so the plan is read again whenever the detail is, and fresh observations update
 * its safety.
 */
export function changePlanOptions(
  organizationId: string,
  orderId: string,
  proposal: OrderChangePlanQuery | null,
  asOf: string | null,
) {
  const query = proposal ?? {};

  return queryOptions({
    ...privateQueryDefaults,
    queryKey: [
      'private',
      'organization',
      organizationId,
      'order',
      orderId,
      'change-plan',
      query,
      asOf,
    ],
    refetchOnReconnect: 'always',
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api.orders.changePlan(
        { params: { organizationId, orderId }, query },
        { signal },
      ),
  });
}
