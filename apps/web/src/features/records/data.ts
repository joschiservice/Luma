import { type RecordKind } from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { IdentityError } from '../../kit/identity/data';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

const api = createWebApiClient();

export const recordsSearch = z.object({
  q: z.string().max(120).catch('').default(''),
  kind: z
    .enum(['order', 'fulfillment', 'position', 'sku', 'product', 'issue'])
    .optional()
    .catch(undefined),
  connectionId: z.string().uuid().optional().catch(undefined),
  from: z.string().max(2048).optional().catch(undefined),
  cursor: z.string().min(1).max(1024).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(100000).optional().catch(undefined),
});

export type RecordsSearch = z.infer<typeof recordsSearch>;

export const recordPageSize = 50;

export type RecordsError = {
  kind: 'access' | 'page' | 'unavailable';
  /** The server's explanation, when it sent one that people can act on. */
  message?: string | undefined;
};

/**
 * Classifies a record list failure. 401, 403 and 404 mean the reader lost access to the
 * workspace. A validation error on a request with a page cursor means the page link no longer
 * matches its search; the reader can start from the first page.
 */
export function recordListError(
  error: unknown,
  search: RecordsSearch,
): RecordsError | undefined {
  if (!error) return undefined;
  if (!(error instanceof IdentityError)) return { kind: 'unavailable' };
  if ([401, 403, 404].includes(error.status)) return { kind: 'access' };
  if (error.code === 'VALIDATION_ERROR' && search.cursor)
    return { kind: 'page', message: error.message };

  return { kind: 'unavailable' };
}

/** Loads one page of current records for a search; `cursor` continues a previous page. */
export function recordsOptions(
  organizationId: string,
  search: {
    q: string;
    kind?: RecordKind | undefined;
    connectionId?: string | undefined;
    cursor?: string | undefined;
  },
) {
  const query = {
    q: search.q,
    kind: search.kind,
    connectionId: search.connectionId,
    cursor: search.cursor,
  };

  return queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'records', query],
    queryFn: ({ signal }) =>
      api.records.list({ params: { organizationId }, query }, { signal }),
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
    queryFn: ({ signal }) =>
      api.records.get(
        { params: { organizationId, kind, recordId } },
        { signal },
      ),
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
