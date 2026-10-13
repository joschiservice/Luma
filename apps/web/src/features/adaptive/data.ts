import {
  type AdaptiveViewDomain,
  type AdaptiveViewQuery,
  adaptiveViewQuerySchema,
} from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

export const adaptiveApi = createWebApiClient();

export const viewsSearch = z.object({
  q: z.string().max(120).optional().catch(undefined),
  cursor: z.string().max(8192).optional().catch(undefined),
});

/** Scopes all adaptive query caches to the trusted workspace. */
export const adaptiveKey = (organizationId: string) =>
  ['private', 'organization', organizationId, 'adaptive'] as const;

/** Reads server-evaluated release flags for the current workspace. */
export const adaptiveAvailabilityOptions = (organizationId: string) =>
  queryOptions({
    ...privateQueryDefaults,
    queryKey: [...adaptiveKey(organizationId), 'availability'],
    queryFn: ({ signal }) =>
      adaptiveApi.adaptive.availability(
        { params: { organizationId } },
        { signal },
      ),
  });

/** Lists authorized saved queries and the reviewed built-in starting points. */
export const viewsOptions = (organizationId: string) =>
  queryOptions({
    ...privateQueryDefaults,
    queryKey: [...adaptiveKey(organizationId), 'views'],
    queryFn: ({ signal }) =>
      adaptiveApi.adaptiveViews.list(
        { params: { organizationId } },
        { signal },
      ),
  });

/** Reads the current version and edit authority of one saved view. */
export const viewOptions = (organizationId: string, viewId: string) =>
  queryOptions({
    ...privateQueryDefaults,
    queryKey: [...adaptiveKey(organizationId), 'view', viewId],
    queryFn: ({ signal }) =>
      adaptiveApi.adaptiveViews.get(
        { params: { organizationId, viewId } },
        { signal },
      ),
  });

/** Runs a bounded read of current owner records, with explicit evidence warnings. */
export const previewOptions = (
  organizationId: string,
  query: AdaptiveViewQuery,
  cursor?: string,
) =>
  queryOptions({
    ...privateQueryDefaults,
    queryKey: [
      ...adaptiveKey(organizationId),
      'preview',
      query,
      cursor ?? null,
    ],
    queryFn: ({ signal }) =>
      adaptiveApi.adaptiveViews.preview(
        {
          params: { organizationId },
          body: { query, ...(cursor ? { cursor } : {}) },
        },
        { signal },
      ),
  });

/** Starts from a small table configuration without filters or consequential actions. */
export function emptyViewQuery(domain: AdaptiveViewDomain): AdaptiveViewQuery {
  return adaptiveViewQuerySchema.parse({
    version: 1,
    domain,
    columns: defaultColumns[domain],
  });
}

export const defaultColumns: Record<AdaptiveViewDomain, string[]> = {
  orders: ['displayNumber', 'status', 'placedAt'],
  inventory: ['sku', 'location', 'differences'],
  fulfillment: ['orderLabel', 'status'],
  customers: ['displayName', 'email'],
  products: ['sku', 'title'],
  procurement: ['reference', 'supplierName', 'status'],
  issues: ['summary', 'state', 'severity'],
  decisions: ['summary', 'reason', 'response'],
};
