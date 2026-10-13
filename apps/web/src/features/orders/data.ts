import {
  type OrderChangePlanQuery,
  type OrderListQuery,
} from '@luma/api-contract';
import { nextCalendarDay, workspaceInstant } from '@luma/ui/lib/timezone';
import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { IdentityError } from '../../kit/identity/data';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

const api = createWebApiClient();

export const orderViews = [
  'all',
  'outstanding',
  'overdue',
  'needs_you',
  'differs',
] as const;

export const orderStatuses = [
  'open',
  'completed',
  'cancelled',
  'unknown',
] as const;

export const orderPaymentStatuses = [
  'pending',
  'authorized',
  'paid',
  'partially_refunded',
  'refunded',
  'failed',
  'unknown',
] as const;

export const orderSorts = ['updated', 'placed', 'number', 'due'] as const;

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value,
  );

/**
 * URL state for the order list. Placed dates are workspace calendar days; updated bounds are
 * exact instants carried over from metric drilldowns.
 */
export const ordersSearch = z.object({
  q: z.string().max(120).optional().catch(undefined),
  view: z.enum(orderViews).optional().catch(undefined),
  status: z.enum(orderStatuses).optional().catch(undefined),
  paymentStatus: z.enum(orderPaymentStatuses).optional().catch(undefined),
  connectionId: z.uuid().optional().catch(undefined),
  placedFrom: day.optional().catch(undefined),
  placedTo: day.optional().catch(undefined),
  updatedFrom: z.iso.datetime().optional().catch(undefined),
  updatedBefore: z.iso.datetime().optional().catch(undefined),
  sort: z.enum(orderSorts).optional().catch(undefined),
  direction: z.enum(['asc', 'desc']).optional().catch(undefined),
  cursor: z.string().max(1024).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(100000).optional().catch(undefined),
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
});

export type OrdersSearch = z.infer<typeof ordersSearch>;

export const orderPageSize = 50;

/** Converts URL filters to the API query, resolving calendar days in the workspace time zone. */
export function orderListQuery(
  search: OrdersSearch,
  timeZone = 'UTC',
): OrderListQuery {
  return {
    q: search.q?.trim() ?? '',
    view: search.view ?? 'all',
    status: search.status,
    paymentStatus: search.paymentStatus,
    connectionId: search.connectionId,
    placedFrom: search.placedFrom
      ? workspaceInstant(search.placedFrom, timeZone)
      : undefined,
    placedBefore: search.placedTo
      ? workspaceInstant(nextCalendarDay(search.placedTo), timeZone)
      : undefined,
    updatedFrom: search.updatedFrom,
    updatedBefore: search.updatedBefore,
    sort: search.sort ?? 'updated',
    direction: search.direction ?? 'desc',
    limit: orderPageSize,
    cursor: search.cursor,
  };
}

/** Returns the list filters without paging, so a filter change starts from the first page. */
export function orderFilters(search: OrdersSearch): OrdersSearch {
  const filters = { ...search };
  delete filters.cursor;
  delete filters.page;
  delete filters.from;
  delete filters.linkedFrom;
  delete filters.changeLine;
  delete filters.changeQuantity;
  delete filters.edit;

  return filters;
}

export type OrdersError = {
  kind: 'access' | 'page' | 'unavailable';
  /** The server's explanation, when it sent one that people can act on. */
  message?: string | undefined;
};

/**
 * Classifies an order list failure. 403 and 404 mean the reader lost access, because the API
 * hides workspaces they no longer belong to. A validation error on a request with a page cursor
 * means the page link no longer matches its filters; the reader can start from the first page.
 */
export function orderListError(
  error: unknown,
  search: OrdersSearch,
): OrdersError | undefined {
  if (!error) return undefined;
  if (!(error instanceof IdentityError)) return { kind: 'unavailable' };
  if ([403, 404].includes(error.status)) return { kind: 'access' };
  if (error.code === 'VALIDATION_ERROR' && search.cursor)
    return { kind: 'page', message: error.message };

  return { kind: 'unavailable' };
}

/** Loads one keyset page of current orders for the active workspace. */
export function ordersOptions(
  organizationId: string,
  search: OrdersSearch,
  timeZone = 'UTC',
) {
  const query = orderListQuery(search, timeZone);

  return queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'orders', query],
    refetchOnReconnect: 'always',
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
