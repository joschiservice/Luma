import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

const api = createWebApiClient();

export const inventorySearch = z.object({
  q: z.string().max(120).optional().catch(undefined),
  view: z.enum(['all', 'differs', 'unknown']).optional().catch(undefined),
  skuId: z.string().uuid().optional().catch(undefined),
  locationId: z.string().uuid().optional().catch(undefined),
  connectionId: z.string().uuid().optional().catch(undefined),
  cursor: z.string().max(1024).optional().catch(undefined),
  from: z.string().max(2048).optional().catch(undefined),
});

export type InventorySearch = z.infer<typeof inventorySearch>;

/** Loads a page of stock positions using validated URL filters. */
export function inventoryOptions(
  organizationId: string,
  search: InventorySearch,
) {
  const query = {
    q: search.q?.trim() ?? '',
    view: search.view ?? 'all',
    skuId: search.skuId,
    locationId: search.locationId,
    connectionId: search.connectionId,
    cursor: search.cursor,
  };

  return queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'inventory', query],
    refetchOnReconnect: 'always',
    queryFn: ({ signal }) =>
      api.inventory.list({ params: { organizationId }, query }, { signal }),
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
