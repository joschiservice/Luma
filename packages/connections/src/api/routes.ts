import { apiContract } from '@luma/api-contract';
import { initServer } from '@ts-rest/fastify';

import type { ProviderCatalog } from '../application/providers.js';

/**
 * Creates provider-catalog handlers with category filtering and not-found responses for
 * unknown IDs.
 */
export function createProviderRoutes(catalog: ProviderCatalog) {
  return initServer().router(apiContract.connectorProviders, {
    list: async ({ query }) => ({
      status: 200,
      body: { items: catalog.list(query.category) },
    }),
    get: async ({ params, request }) => {
      const provider = catalog.get(params.providerId);

      return provider
        ? { status: 200, body: provider }
        : {
            status: 404,
            body: {
              code: 'NOT_FOUND',
              message: 'Provider not found',
              requestId: request.id,
            },
          };
    },
  });
}
