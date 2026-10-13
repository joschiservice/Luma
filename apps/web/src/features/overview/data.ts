import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

export const overviewSearch = z.object({
  window: z.enum(['24h', '7d']).catch('24h').default('24h'),
});

const api = createWebApiClient();

/**
 * Loads the selected operations window and refreshes it every 30 seconds and when
 * connectivity or focus returns.
 */
export function overviewOptions(
  organizationId: string,
  window: '24h' | '7d',
  bounds?: { start: string; end: string },
) {
  return queryOptions({
    queryKey: [
      'private',
      'organization',
      organizationId,
      'overview',
      window,
      ...(bounds ? [bounds] : []),
    ],
    ...privateQueryDefaults,
    refetchInterval: 30_000,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
    queryFn: ({ signal }) =>
      api.operations.overview(
        { params: { organizationId }, query: { window, ...bounds } },
        { signal },
      ),
  });
}
