import { queryOptions } from '@tanstack/react-query';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

const api = createWebApiClient();

/**
 * Reads every supplier, alphabetically, for choosers that list them all. Follows pages until
 * the directory ends; stops after 2,000 suppliers and reports `truncated`. The key sits under
 * the workspace's procurement cache prefix, so procurement changes refresh it.
 */
export const allSuppliersOptions = (organizationId: string) =>
  queryOptions({
    queryKey: [
      'private',
      'organization',
      organizationId,
      'procurement',
      'suppliers',
      'all',
    ],
    ...privateQueryDefaults,
    queryFn: async ({ signal }) => {
      const page = await api.procurement.suppliers(
        { params: { organizationId }, query: { limit: 50 } },
        { signal },
      );
      const items = [...page.items];
      let cursor = page.nextCursor;
      while (cursor && items.length < 2000) {
        const next = await api.procurement.suppliers(
          { params: { organizationId }, query: { limit: 50, cursor } },
          { signal },
        );
        items.push(...next.items);
        cursor = next.nextCursor;
      }

      return { items, canManage: page.canManage, truncated: !!cursor };
    },
  });
