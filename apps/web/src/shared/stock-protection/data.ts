import { queryOptions } from '@tanstack/react-query';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

export const stockProtectionApi = createWebApiClient().stockProtection;

/** Shares one bounded stock-protection snapshot across Home, stock, product and incident views. */
export const stockProtectionOptions = (
  organizationId: string,
  filters: {
    incidentId?: string | undefined;
    positionId?: string | undefined;
    skuId?: string | undefined;
    offset?: number;
    limit?: number;
  } = {},
) =>
  queryOptions({
    queryKey: [
      'private',
      'organization',
      organizationId,
      'stock-protection',
      filters,
    ],
    ...privateQueryDefaults,
    queryFn: ({ signal }) =>
      stockProtectionApi.view(
        { params: { organizationId }, body: filters },
        { signal },
      ),
    refetchInterval: 30000,
    retry: false,
  });
