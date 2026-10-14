import {
  type AdaptiveRecordType,
  type AdaptiveViewDomain,
  type AdaptiveViewQuery,
  adaptiveViewQuerySchema,
  collectionDomainSchema,
} from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

export const adaptiveApi = createWebApiClient();

export const viewsSearch = z.object({
  q: z.string().max(120).optional().catch(undefined),
  /** Narrows the directory to one list's views. */
  domain: collectionDomainSchema.optional().catch(undefined),
  /** Narrows the directory by who can open a view. */
  sharing: z
    .enum(['private', 'workspace', 'roles'])
    .optional()
    .catch(undefined),
  /** Opens a view's settings, history and actions instead of its list page. */
  manage: z.boolean().optional().catch(undefined),
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

/** Starts from a small table of catalog columns without filters or consequential actions. */
export function emptyViewQuery(domain: AdaptiveViewDomain): AdaptiveViewQuery {
  return adaptiveViewQuerySchema.parse({
    version: 2,
    domain,
    state: { columns: defaultColumns[domain].map((id) => ({ id })) },
  });
}

/** Catalog columns a new view starts with; every one is readable by the view preview. */
const defaultColumns: Record<AdaptiveViewDomain, string[]> = {
  orders: ['number', 'status', 'placed'],
  inventory: ['sku', 'location', 'differences'],
  fulfillment: ['order', 'status'],
  customers: ['name', 'email'],
  products: ['sku', 'title'],
  procurement: ['reference', 'supplier', 'status'],
  issues: ['summary', 'state', 'severity'],
  decisions: ['title', 'kind', 'reason'],
  returns: ['name', 'stage', 'requested'],
};

/**
 * Lists a record type's custom fields the reader may see, including archived ones, so lists can
 * mark views that still use them as needing repair.
 */
export const customFieldsOptions = (
  organizationId: string,
  recordType: AdaptiveRecordType,
) =>
  queryOptions({
    ...privateQueryDefaults,
    queryKey: [...adaptiveKey(organizationId), 'fields', recordType],
    queryFn: ({ signal }) =>
      adaptiveApi.adaptiveFields.list(
        {
          params: { organizationId },
          query: { recordType, includeArchived: true },
        },
        { signal },
      ),
  });

/** Reads permitted custom field values of the records on one list page, in one request. */
export const customFieldValuesOptions = (
  organizationId: string,
  recordType: AdaptiveRecordType,
  recordIds: readonly string[],
) =>
  queryOptions({
    ...privateQueryDefaults,
    queryKey: [
      ...adaptiveKey(organizationId),
      'field-values',
      recordType,
      [...recordIds].sort(),
    ],
    queryFn: ({ signal }) =>
      adaptiveApi.adaptiveFields.readMany(
        {
          params: { organizationId, recordType },
          body: { recordIds: [...recordIds].slice(0, 100) },
        },
        { signal },
      ),
  });
