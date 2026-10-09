import { apiContract } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';

import type { ProviderCatalog } from '../application/providers.js';

/**
 * Creates provider-catalog handlers with category filtering and not-found responses for
 * unknown IDs.
 */
export function createProviderRoutes(catalog: ProviderCatalog) {
  const os = implement(apiContract.connectorProviders).$context<HttpContext>();

  return os.router({
    list: os.list.handler(async ({ input: { query } }) => ({
      items: catalog.list(query.category),
    })),
    get: os.get.handler(async ({ input: { params } }) => {
      const provider = catalog.get(params.providerId);
      if (!provider)
        throw new IdentityError(404, 'NOT_FOUND', 'Provider not found');

      return provider;
    }),
  });
}
