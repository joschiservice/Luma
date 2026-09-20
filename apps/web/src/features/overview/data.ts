import { operationsOverviewSchema } from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { IdentityError } from '../identity/data';

export const overviewSearch = z.object({
  window: z.enum(['24h', '7d']).catch('24h').default('24h'),
});

const api = createWebApiClient();

/**
 * Loads the selected operations window and refreshes it every 30 seconds and when
 * connectivity or focus returns.
 */
export function overviewOptions(organizationId: string, window: '24h' | '7d') {
  return queryOptions({
    queryKey: ['private', 'organization', organizationId, 'overview', window],
    ...privateQueryDefaults,
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
