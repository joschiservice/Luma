import {
  customerSortSchema,
  customerStateSchema,
  type OrderSort,
} from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

const api = createWebApiClient();

/**
 * URL state of the customer list. Search text is personal data, so it stays in page state and
 * never enters the URL. `customerId` with `connectionId` is a source customer link, for example
 * from an order's source panel, that the page resolves to the imported profile.
 */
export const customersSearch = z.object({
  state: z.enum(customerStateSchema.options).optional().catch(undefined),
  connectionId: z.string().uuid().optional().catch(undefined),
  sort: z.enum(customerSortSchema.options).optional().catch(undefined),
  direction: z.enum(['asc', 'desc']).optional().catch(undefined),
  cursor: z.string().max(4096).optional().catch(undefined),
  customerId: z.string().max(1024).optional().catch(undefined),
});

export type CustomersSearch = z.infer<typeof customersSearch>;

export const customerPageSize = 50;

/** The list filters without paging or a source link; a change of these starts at page one. */
export function customerFilters(search: CustomersSearch): CustomersSearch {
  const filters = { ...search };
  delete filters.cursor;
  delete filters.customerId;

  return filters;
}

/** Builds the API query for validated URL filters and the current search text. */
export function customerListQuery(search: CustomersSearch, q = '') {
  const sort = search.sort ?? 'created';

  return {
    q: q.trim(),
    state: search.state,
    connectionId: search.connectionId,
    sort,
    direction: search.direction ?? (sort === 'name' ? 'asc' : 'desc'),
    cursor: search.cursor,
    limit: customerPageSize,
  };
}

/** Loads a page of imported customer profiles with their sources. */
export function customersOptions(
  organizationId: string,
  search: CustomersSearch,
  q = '',
) {
  const query = customerListQuery(search, q);

  return queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'customers', query],
    refetchOnReconnect: 'always',
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
