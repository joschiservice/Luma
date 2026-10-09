import { type MetricRequest } from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

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
    queryFn: ({ signal }) =>
      api.metrics.query(
        { params: { organizationId }, body: request },
        { signal },
      ),
  });
}
