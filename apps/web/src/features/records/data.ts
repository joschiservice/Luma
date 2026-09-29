import {
  recordDetailSchema,
  type RecordKind,
  recordListSchema,
} from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { IdentityError } from '../identity/data';

const api = createWebApiClient();

export const recordsSearch = z.object({
  q: z.string().max(120).catch('').default(''),
  kind: z
    .enum(['order', 'fulfillment', 'position', 'sku', 'product', 'issue'])
    .optional()
    .catch(undefined),
  connectionId: z.string().uuid().optional().catch(undefined),
  from: z.string().max(2048).optional().catch(undefined),
});

/** Loads a bounded, tenant-scoped page of current records. */
export function recordsOptions(
  organizationId: string,
  search: {
    q: string;
    kind?: RecordKind | undefined;
    connectionId?: string | undefined;
  },
) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'records', search],
    queryFn: async ({ signal }) => {
      const result = await api.records.list({
        params: { organizationId },
        query: search,
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) throw new IdentityError(result.status);

      return recordListSchema.parse(result.body);
    },
  });
}

/** Loads one record and its confirmed relationships within the active tenant. */
export function recordOptions(
  organizationId: string,
  kind: RecordKind,
  recordId: string,
) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: [
      'private',
      'organization',
      organizationId,
      'record',
      kind,
      recordId,
    ],
    queryFn: async ({ signal }) => {
      const result = await api.records.get({
        params: { organizationId, kind, recordId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) throw new IdentityError(result.status);

      return recordDetailSchema.parse(result.body);
    },
  });
}

/** Accepts a return URL only when it stays inside the same workspace. */
export function recordReturnPath(organizationId: string, from?: string) {
  const prefix = `/app/${encodeURIComponent(organizationId)}/`;
  if (!from?.startsWith(prefix) || from.includes('\\') || from.includes('//'))
    return null;
  const parsed = new URL(from, 'https://workspace.invalid');

  return parsed.origin === 'https://workspace.invalid' &&
    parsed.pathname.startsWith(prefix)
    ? `${parsed.pathname}${parsed.search}${parsed.hash}`
    : null;
}
