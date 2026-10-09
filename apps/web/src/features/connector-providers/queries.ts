import type { ApiClient } from '@luma/api-contract/client';
import { queryOptions } from '@tanstack/react-query';

import { createUserActionHeaders } from '../../lib/user-action';

/**
 * Builds the provider-detail query for the supplied client and provider ID. Error statuses
 * reject with the client's error; the web client's error carries the server's message.
 */
export function connectorProviderQueryOptions(
  client: ApiClient,
  providerId: string,
) {
  const headers = createUserActionHeaders();

  return queryOptions({
    queryKey: ['connector-providers', providerId],
    queryFn: ({ signal }) =>
      client.connectorProviders.get(
        { params: { providerId } },
        { signal, context: { headers } },
      ),
  });
}
