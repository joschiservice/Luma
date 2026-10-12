import { caseClasses, type CaseQuery, caseStates } from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { IdentityError } from '../../kit/identity/data';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

export const inboxSearch = z.object({
  ownerId: z
    .union([z.string().uuid(), z.literal('unassigned')])
    .optional()
    .catch(undefined),
  shadow: z.string().min(1).max(200).optional().catch(undefined),
  view: z
    .enum(['needs_you', 'active', 'history'])
    .catch('needs_you')
    .default('needs_you'),
  class: z.enum(caseClasses).optional().catch(undefined),
  severity: z.enum(['high', 'medium']).optional().catch(undefined),
  state: z.enum(caseStates).optional().catch(undefined),
  cursor: z.string().min(1).max(2048).optional().catch(undefined),
});

export type InboxSearch = z.infer<typeof inboxSearch>;

const api = createWebApiClient();

/** Returns the query-key prefix for all case data in one organization. */
export const casesKey = (organizationId: string) =>
  ['private', 'organization', organizationId, 'cases'] as const;

const options = {
  ...privateQueryDefaults,
  refetchOnWindowFocus: 'always',
} as const;

/** Loads a validated inbox page using the requested view, filters, and cursor. */
export function casesOptions(organizationId: string, search: InboxSearch) {
  const query: CaseQuery = { ...search, limit: 25 };

  return queryOptions({
    ...options,
    queryKey: [...casesKey(organizationId), 'list', query],
    queryFn: ({ signal }) =>
      api.exceptions.list({ params: { organizationId }, query }, { signal }),
  });
}

/**
 * Loads a validated case detail; rejects invalid IDs and disables fetching for an empty
 * selection.
 */
export function caseOptions(organizationId: string, exceptionId: string) {
  return queryOptions({
    ...options,
    queryKey: [...casesKey(organizationId), 'detail', exceptionId],
    enabled: Boolean(exceptionId),
    queryFn: async ({ signal }) => {
      if (!z.uuid().safeParse(exceptionId).success)
        throw new IdentityError(404);

      return api.exceptions.get(
        { params: { organizationId, exceptionId } },
        { signal },
      );
    },
  });
}

/** Checks whether a case still belongs in the selected inbox view and filters. */
export function matchesView(
  item: import('@luma/api-contract').CaseSummary,
  search: InboxSearch,
) {
  return (
    (search.view === 'needs_you'
      ? item.attention.required
      : search.view === 'history'
        ? item.state === 'resolved'
        : item.state !== 'resolved') &&
    (!search.class || search.class === item.class) &&
    (!search.severity || search.severity === item.severity) &&
    (!search.state || search.state === item.state)
  );
}
