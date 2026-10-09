import { type DecisionAssignInput } from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

const api = createWebApiClient();

export const needsYouSearch = z.object({
  view: z.enum(['all', 'mine', 'unassigned']).optional().catch(undefined),
  domain: z
    .enum(['orders', 'fulfillment', 'inventory', 'procurement', 'operations'])
    .optional()
    .catch(undefined),
  reason: z
    .enum(['approval', 'run', 'recovery', 'manual_intervention', 'uncertainty'])
    .optional()
    .catch(undefined),
  cursor: z.string().max(2000).optional().catch(undefined),
  /** The selected decision, kept in the URL so links and Back restore it. */
  item: z.string().max(200).optional().catch(undefined),
  grouped: z.boolean().optional().catch(undefined),
});

export type NeedsYouSearch = z.infer<typeof needsYouSearch>;

/** The filters that define a queue; changing them starts at page one. */
export function needsYouFilters(search: NeedsYouSearch) {
  return {
    view: search.view ?? 'all',
    domain: search.domain,
    reason: search.reason,
  };
}

/** Caches every Needs you read for one workspace so decisions anywhere can refresh them. */
export const decisionsKey = (organizationId: string) =>
  ['private', 'organization', organizationId, 'decisions'] as const;

/**
 * Loads a page of decisions that need a person. It polls while visible as a fallback for the
 * live stream and refetches on focus and reconnect.
 */
export function decisionsOptions(
  organizationId: string,
  search: Pick<NeedsYouSearch, 'view' | 'domain' | 'reason' | 'cursor'>,
  limit = 25,
) {
  const query = {
    ...needsYouFilters(search),
    ...(search.cursor ? { cursor: search.cursor } : {}),
    limit,
  };

  return queryOptions({
    ...privateQueryDefaults,
    queryKey: [...decisionsKey(organizationId), query],
    refetchInterval: 30_000,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
    queryFn: ({ signal }) =>
      api.decisions.list({ params: { organizationId }, query }, { signal }),
  });
}

/** Takes, hands over or releases a decision at the assignment revision the reader saw. */
export async function assignDecision(
  organizationId: string,
  body: DecisionAssignInput,
) {
  return api.decisions.assign({ params: { organizationId }, body });
}

/** Loads one decision for a direct link to an item outside the current page. */
export function decisionOptions(organizationId: string, id: string) {
  const query = { view: 'all' as const, id, limit: 1 };

  return queryOptions({
    ...privateQueryDefaults,
    queryKey: [...decisionsKey(organizationId), 'item', id],
    refetchOnWindowFocus: 'always',
    queryFn: async ({ signal }) => {
      const result = await api.decisions.list(
        { params: { organizationId }, query },
        { signal },
      );

      return result.items[0] ?? null;
    },
  });
}
