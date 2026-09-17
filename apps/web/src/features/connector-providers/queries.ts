import type { ApiClient } from '@luma/api-contract/client';
import { queryOptions } from '@tanstack/react-query';

export function connectorProviderQueryOptions(
  client: ApiClient,
  providerId: string,
) {
  return queryOptions({
    queryKey: ['connector-providers', providerId],
    queryFn: async ({ signal }) => {
      const response = await client.connectorProviders.get({
        params: { providerId },
        fetchOptions: { signal },
      });
      if (response.status !== 200) throw new Error(response.body.message);
      return response.body;
    },
  });
}
