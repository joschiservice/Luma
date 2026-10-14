import {
  type CollectionGroup,
  type CollectionViewState,
  customerQuerySchema,
  customerSortSchema,
  customerStateSchema,
  type OrderSort,
} from '@luma/api-contract';
import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { withLegacyConditions } from '../../kit/collections/legacy';
import { collectionSearchShape, groupOf } from '../../kit/collections/state';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { legacyCustomerConditions } from './collection';

const api = createWebApiClient();

/** The list request as the API client accepts it. */
export type CustomerListQueryInput = z.input<typeof customerQuerySchema>;

/** Page context the Customers pages carry besides the view. */
const contextShape = {
  /** The customer open in the preview pane. */
  item: z.uuid().optional().catch(undefined),
  /**
   * A source customer link, for example from an order's source panel, with its `connectionId`;
   * the page resolves it to the imported profile.
   */
  customerId: z.string().max(1024).optional().catch(undefined),
};

/**
 * URL state of the Customers list and customer pages: the shared list keys (view, conditions,
 * sort, grouping, display and paging), filters of older links and page context. Search text is
 * personal data: `q` only arrives with links, and the page moves it into page state. A
 * `connectionId` names the source of a linked `customerId`; without one it is an older link's
 * source filter.
 */
export const customersSearch = z.object({
  ...collectionSearchShape,
  state: z.enum(customerStateSchema.options).optional().catch(undefined),
  connectionId: z.uuid().optional().catch(undefined),
  ...contextShape,
});

export type CustomersSearch = z.infer<typeof customersSearch>;

export const customerPageSize = 50;

/** Rows each group shows before "Show more", and the size of each further page. */
const customerGroupPageSize = 10;

/** Whether the URL still uses filters or sort names of older links. */
export function hasLegacyFilters(search: CustomersSearch) {
  return (
    search.state !== undefined ||
    (search.connectionId !== undefined && !search.customerId) ||
    search.sort === 'amountSpent'
  );
}

/**
 * Rewrites older filter keys into conditions, merged with the URL's own conditions, and the
 * older `amountSpent` sort into the catalog's `spent`, starting from the first page.
 */
export function withoutLegacyFilters(search: CustomersSearch): CustomersSearch {
  const conditions = legacyCustomerConditions(search);
  const next: CustomersSearch = { ...search };
  delete next.state;
  if (!next.customerId) delete next.connectionId;
  if (next.sort === 'amountSpent') next.sort = 'spent';
  delete next.cursor;
  delete next.page;

  return conditions.length
    ? { ...next, where: withLegacyConditions(search.where, conditions) }
    : next;
}

/** Whether the URL says what to show, so the page must not restore the remembered view. */
export function namesListState(search: CustomersSearch) {
  return Boolean(
    search.q ||
    search.cursor ||
    search.page ||
    search.item ||
    search.customerId,
  );
}

/** The list state without paging and page context, so the list starts on page one. */
export function customerFilters(search: CustomersSearch): CustomersSearch {
  const filters = { ...search };
  delete filters.q;
  delete filters.cursor;
  delete filters.page;
  delete filters.item;
  delete filters.customerId;
  delete filters.connectionId;

  return filters;
}

const sorts = new Set<string>(customerSortSchema.options);

/** The API's sort for a catalog sort field; the catalog's `spent` is the API's `amountSpent`. */
function apiSort(field: string | undefined): CustomerListQueryInput['sort'] {
  if (field === 'spent') return 'amountSpent';
  if (field && sorts.has(field))
    return field as NonNullable<CustomerListQueryInput['sort']>;
  // The server checks that a custom field exists and is readable.
  if (field && /^custom:[0-9a-f-]{36}$/.test(field))
    return field as `custom:${string}`;

  return 'created';
}

/**
 * Builds the list request for a view: conditions (sent only when there are any), sort (a
 * catalog or custom field) and grouping, with the private search text and the page cursor.
 * Grouped reads return each group's first rows and take no page cursor; `group` reads one
 * group's next page instead. Calendar conditions and date groups follow `timeZone`.
 */
export function customerListQuery(
  state: CollectionViewState,
  search: { q: string; cursor?: string | undefined },
  timeZone: string,
  group?: { key: CollectionGroup['key']; cursor: string },
): CustomerListQueryInput {
  const grouping = groupOf(state);

  return {
    q: search.q.trim(),
    ...(state.where.conditions.length
      ? { where: JSON.stringify(state.where) }
      : {}),
    sort: apiSort(state.sort?.field),
    direction: state.sort?.direction ?? 'desc',
    timeZone,
    ...(grouping
      ? group
        ? {
            group: grouping,
            groupKey: JSON.stringify(group.key),
            cursor: group.cursor,
            limit: customerPageSize,
          }
        : { group: grouping, groupLimit: customerGroupPageSize }
      : { limit: customerPageSize, cursor: search.cursor }),
  };
}

/** Loads a page of imported customer profiles with their sources, or a grouped read. */
export function customersOptions(
  organizationId: string,
  query: CustomerListQueryInput,
) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'customers', query],
    refetchOnReconnect: 'always',
    // A changed filter keeps the previous rows visible until the new ones arrive.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api.customers.list({ params: { organizationId }, query }, { signal }),
  });
}

/**
 * Finds the imported profile of one source customer. Resolves to its Luma ID, or null when
 * Luma has not imported this customer.
 */
export function customerSourceOptions(
  organizationId: string,
  connectionId: string,
  externalId: string,
) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: [
      'private',
      'organization',
      organizationId,
      'customer-source',
      connectionId,
      externalId,
    ],
    queryFn: async ({ signal }) => {
      const result = await api.customers.list(
        {
          params: { organizationId },
          query: { connectionId, externalId, limit: 1 },
        },
        { signal },
      );

      return result.items[0]?.id ?? null;
    },
  });
}

/** Loads one imported customer profile with its address and source. */
export function customerOptions(organizationId: string, customerId: string) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: [
      'private',
      'organization',
      organizationId,
      'customer',
      customerId,
    ],
    refetchOnReconnect: 'always',
    queryFn: ({ signal }) =>
      api.customers.get({ params: { organizationId, customerId } }, { signal }),
  });
}

export const customerOrderPageSize = 20;

/** Sorting and paging of a customer's order history, kept in page state. */
export interface CustomerOrdersState {
  sort: OrderSort;
  direction: 'asc' | 'desc';
  cursor?: string | undefined;
}

/**
 * Loads one page of the Luma orders whose source attributes them to this imported customer,
 * with the exact number of matches. Requires order and customer access.
 */
export function customerOrdersOptions(
  organizationId: string,
  customerId: string,
  state: CustomerOrdersState,
) {
  const query = {
    customerId,
    count: 'exact' as const,
    sort: state.sort,
    direction: state.direction,
    cursor: state.cursor,
    limit: customerOrderPageSize,
  };

  return queryOptions({
    ...privateQueryDefaults,
    queryKey: [
      'private',
      'organization',
      organizationId,
      'customer-orders',
      query,
    ],
    refetchOnReconnect: 'always',
    queryFn: ({ signal }) =>
      api.orders.list({ params: { organizationId }, query }, { signal }),
  });
}
