import { returnStageSchema, type ReturnView } from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

const api = createWebApiClient();

export const returnsSearch = z.object({
  q: z.string().max(120).optional().catch(undefined),
  view: z
    .enum(['action', 'waiting', 'done', 'all'])
    .optional()
    .catch(undefined),
  stage: z.enum(returnStageSchema.options).optional().catch(undefined),
  connectionId: z.string().uuid().optional().catch(undefined),
  sort: z.enum(['oldest', 'newest', 'activity']).optional().catch(undefined),
  cursor: z.string().max(4096).optional().catch(undefined),
  from: z.string().max(2048).optional().catch(undefined),
});

export type ReturnsSearch = z.infer<typeof returnsSearch>;

export type ReturnSort = NonNullable<ReturnsSearch['sort']>;

/** Opens on pending work; the oldest request waits longest, so it comes first. */
export const defaultView: ReturnView = 'action';

/** The list sort for a view when none is chosen: oldest first for work, newest otherwise. */
export const defaultSort = (view: ReturnView): ReturnSort =>
  view === 'action' || view === 'waiting' ? 'oldest' : 'newest';

/** The list filters without paging and return context; a change of these starts at page one. */
export function returnFilters(search: ReturnsSearch): ReturnsSearch {
  const filters = { ...search };
  delete filters.cursor;
  delete filters.from;

  return filters;
}

/** Builds the API query for validated URL filters. */
export function returnListQuery(search: ReturnsSearch) {
  const view = search.view ?? defaultView;
  const sort = search.sort ?? defaultSort(view);

  return {
    q: search.q?.trim() ?? '',
    view,
    stage: search.stage,
    connectionId: search.connectionId,
    sort: sort === 'activity' ? ('activity' as const) : ('requested' as const),
    direction: sort === 'oldest' ? ('asc' as const) : ('desc' as const),
    cursor: search.cursor,
  };
}

/** Loads a page of returns with counts per view and stage using validated URL filters. */
export function returnsOptions(organizationId: string, search: ReturnsSearch) {
  const query = returnListQuery(search);

  return queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'returns', query],
    refetchOnReconnect: 'always',
    queryFn: ({ signal }) =>
      api.returns.list({ params: { organizationId }, query }, { signal }),
  });
}

/** Loads one return with its items, refunds, order and evidence. */
export function returnOptions(organizationId: string, returnId: string) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'return', returnId],
    refetchOnReconnect: 'always',
    queryFn: ({ signal }) =>
      api.returns.get({ params: { organizationId, returnId } }, { signal }),
  });
}

/** Loads only the per-view and per-stage counts and sources, for summaries such as Home. */
export function returnSummaryOptions(organizationId: string) {
  const query = { ...returnListQuery({ view: 'all' }), limit: 1 };

  return queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'returns', query],
    refetchOnReconnect: 'always',
    queryFn: ({ signal }) =>
      api.returns.list({ params: { organizationId }, query }, { signal }),
  });
}
