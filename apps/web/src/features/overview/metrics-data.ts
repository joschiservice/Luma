import { type MetricRequest, metricResponseSchema } from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { IdentityError } from '../identity/data';

const api = createWebApiClient();

/** Reads totals and a page of matching orders for each metric, from current data. */
export function metricsOptions(
  organizationId: string,
  request: MetricRequest = {},
) {
  return queryOptions({
    queryKey: [
      'private',
      'organization',
      organizationId,
      'order-metrics',
      request,
    ],
    ...privateQueryDefaults,
    retry: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    queryFn: async ({ signal }) => {
      const result = await api.metrics.query({
        params: { organizationId },
        body: request,
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200)
        throw new IdentityError(result.status, result.body);

      return metricResponseSchema.parse(result.body);
    },
  });
}
