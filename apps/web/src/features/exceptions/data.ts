import { queryOptions } from '@tanstack/react-query';
import {
  caseDetailSchema,
  caseListSchema,
  type CaseQuery,
} from '@luma/api-contract';
import { z } from 'zod';
import { caseClasses, caseStates } from '@luma/api-contract';
import { createWebApiClient } from '../../lib/api-client';
import { IdentityError } from '../identity/data';
export const inboxSearch = z.object({
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
export const casesKey = (organizationId: string) =>
  ['private', 'organization', organizationId, 'cases'] as const;
const options = {
  staleTime: 0,
  gcTime: 0,
  retry: false,
  refetchOnWindowFocus: 'always',
} as const;
export function casesOptions(organizationId: string, search: InboxSearch) {
  const query: CaseQuery = { ...search, limit: 25 };
  return queryOptions({
    ...options,
    queryKey: [...casesKey(organizationId), 'list', query],
    queryFn: async ({ signal }) => {
      const result = await api.exceptions.list({
        params: { organizationId },
        query,
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) throw new IdentityError(result.status);
      return caseListSchema.parse(result.body);
    },
  });
}
export function caseOptions(organizationId: string, exceptionId: string) {
  return queryOptions({
    ...options,
    queryKey: [...casesKey(organizationId), 'detail', exceptionId],
    enabled: Boolean(exceptionId),
    queryFn: async ({ signal }) => {
      if (!z.uuid().safeParse(exceptionId).success)
        throw new IdentityError(404);
      const result = await api.exceptions.get({
        params: { organizationId, exceptionId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) throw new IdentityError(result.status);
      return caseDetailSchema.parse(result.body);
    },
  });
}
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
