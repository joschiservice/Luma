import {
  type OperationalMetricRequest,
  operationalMetricResponseSchema,
} from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { IdentityError } from '../identity/data';

const api = createWebApiClient();

export const operationalMetricRequest: OperationalMetricRequest = {
  definitionVersion: 2,
  metrics: [
    'cases.attention',
    'cases.active',
    'cases.oldest_unresolved_age',
    'inventory.below_minimum',
    'inventory.replenishment_unknown',
    'procurement.purchase_orders.draft',
    'procurement.purchase_orders.open',
    'connections.needing_attention',
  ],
};

/** Reads selected metric families with per-family coverage and a page of each cohort. */
export function operationalMetricsOptions(
  organizationId: string,
  request: OperationalMetricRequest,
) {
  return queryOptions({
    queryKey: [
      'private',
      'organization',
      organizationId,
      request.metrics.some((id) => id.startsWith('resolution.'))
        ? 'resolution-metrics'
        : 'operational-metrics',
      request,
    ],
    ...privateQueryDefaults,
    retry: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    queryFn: async ({ signal }) => {
      const result = await api.metrics.operationalQuery({
        params: { organizationId },
        body: request,
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200)
        throw new IdentityError(result.status, result.body);

      return operationalMetricResponseSchema.parse(result.body);
    },
  });
}
