import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

const api = createWebApiClient();

export const productsSearch = z.object({
  q: z.string().max(120).optional().catch(undefined),
  view: z
    .enum(['all', 'differs', 'missing', 'unlinked'])
    .optional()
    .catch(undefined),
  connectionId: z.string().uuid().optional().catch(undefined),
  missingFrom: z.string().uuid().optional().catch(undefined),
  cursor: z.string().max(8192).optional().catch(undefined),
  from: z.string().max(2048).optional().catch(undefined),
});

export type ProductsSearch = z.infer<typeof productsSearch>;

/** The list filters without paging and return context; a change of these starts at page one. */
export function productFilters(search: ProductsSearch): ProductsSearch {
  const filters = { ...search };
  delete filters.cursor;
  delete filters.from;

  return filters;
}

/** Builds the API query for validated URL filters. */
export function productListQuery(search: ProductsSearch) {
  return {
    q: search.q?.trim() ?? '',
    view: search.view ?? 'all',
    connectionId: search.connectionId,
    missingFrom: search.missingFrom,
    cursor: search.cursor,
  };
}

/** Loads a page of catalog SKUs with per-view counts using validated URL filters. */
export function productsOptions(
  organizationId: string,
  search: ProductsSearch,
) {
  const query = productListQuery(search);

  return queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'products', query],
    refetchOnReconnect: 'always',
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
  const query = { ...productListQuery({}), limit: 1 };

  return queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'products', query],
    refetchOnReconnect: 'always',
    queryFn: ({ signal }) =>
      api.products.list({ params: { organizationId }, query }, { signal }),
  });
}
