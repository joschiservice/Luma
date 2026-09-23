import { createProviderRoutes } from './api/routes.js';
import {
  createProviderCatalog,
  type ProviderCatalog,
} from './application/providers.js';

/** Creates provider-catalog routes, using the built-in catalog unless one is supplied. */
export function createConnectors(
  catalog: ProviderCatalog = createProviderCatalog(),
) {
  return createProviderRoutes(catalog);
}

export { connectionRoutes } from './api/installations.js';

export { registerShopifyRoutes } from './api/shopify.js';
