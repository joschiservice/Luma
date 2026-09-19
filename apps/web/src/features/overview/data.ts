import { queryOptions } from '@tanstack/react-query';
import { operationsOverviewSchema } from '@luma/api-contract';
import { z } from 'zod';
import { createWebApiClient } from '../../lib/api-client';
import { IdentityError } from '../identity/data';
export const overviewSearch = z.object({
  window: z.enum(['24h', '7d']).catch('24h').default('24h'),
});
const api = createWebApiClient();
export function overviewOptions(organizationId: string, window: '24h' | '7d') {
  return queryOptions({
    queryKey: ['private', 'organization', organizationId, 'overview', window],
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: 30_000,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
    queryFn: async ({ signal }) => {
      const result = await api.operations.overview({
        params: { organizationId },
        query: { window },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) throw new IdentityError(result.status);
      return operationsOverviewSchema.parse(result.body);
    },
  });
}
