import type { ApiClient } from '@luma/api-contract/client';
import { queryOptions } from '@tanstack/react-query';

import { createUserActionHeaders } from '../../lib/user-action';

/** Builds the provider-detail query for the supplied client and provider ID. */
export function connectorProviderQueryOptions(
  client: ApiClient,
  providerId: string,
) {
  const headers = createUserActionHeaders();

  return queryOptions({
    queryKey: ['connector-providers', providerId],
    queryFn: async ({ signal }) => {
      const response = await client.connectorProviders.get({
        params: { providerId },
        extraHeaders: headers,
        fetchOptions: { signal },
      });
      if (response.status !== 200) throw new Error(response.body.message);

      return response.body;
    },
  });
}
