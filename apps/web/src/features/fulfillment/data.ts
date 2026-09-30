import {
  fulfillmentDetailSchema,
  fulfillmentListSchema,
} from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { IdentityError } from '../identity/data';

const api = createWebApiClient();

export const fulfillmentSearch = z.object({
  q: z.string().max(120).optional().catch(undefined),
  view: z
    .enum(['attention', 'held', 'delayed', 'open', 'in_transit', 'all'])
    .optional()
    .catch(undefined),
  connectionId: z.string().uuid().optional().catch(undefined),
  locationId: z.string().uuid().optional().catch(undefined),
  kind: z.enum(['fulfillment_order', 'shipment']).optional().catch(undefined),
  sort: z.enum(['waiting', 'recent', 'deadline']).optional().catch(undefined),
  cursor: z.string().max(8192).optional().catch(undefined),
  from: z.string().max(2048).optional().catch(undefined),
});

export type FulfillmentSearch = z.infer<typeof fulfillmentSearch>;

/** The list filters without paging and return context; a change of these starts at page one. */
export function fulfillmentFilters(
  search: FulfillmentSearch,
): FulfillmentSearch {
  const filters = { ...search };
  delete filters.cursor;
  delete filters.from;

  return filters;
}

/** Builds the API query for validated URL filters. */
export function fulfillmentListQuery(search: FulfillmentSearch) {
  return {
    q: search.q?.trim() ?? '',
    view: search.view ?? 'attention',
    connectionId: search.connectionId,
    locationId: search.locationId,
    kind: search.kind,
    sort: search.sort ?? 'waiting',
    cursor: search.cursor,
  };
}

/** Loads a page of fulfillments with per-view counts using validated URL filters. */
export function fulfillmentsOptions(
  organizationId: string,
  search: FulfillmentSearch,
  limit?: number,
) {
  const query = {
    ...fulfillmentListQuery(search),
    ...(limit ? { limit } : {}),
  };

  return queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'fulfillment', query],
    refetchOnReconnect: 'always',
    queryFn: async ({ signal }) => {
      const result = await api.fulfillment.list({
        params: { organizationId },
        query,
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200)
        throw new IdentityError(result.status, result.body);

      return fulfillmentListSchema.parse(result.body);
    },
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
    queryFn: async ({ signal }) => {
      const result = await api.fulfillment.get({
        params: { organizationId, fulfillmentId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200)
        throw new IdentityError(result.status, result.body);

      return fulfillmentDetailSchema.parse(result.body);
    },
  });
}
