import { createProviderRoutes } from './api/routes.js';
import {
  createProviderCatalog,
  type ProviderCatalog,
} from './application/providers.js';

/** Creates provider-catalog routes, using only the supplied provider catalog. */
export function createConnectors(
  catalog: ProviderCatalog = createProviderCatalog(),
) {
  return createProviderRoutes(catalog);
}

export { connectionRoutes } from './api/installations.js';

export { sourceAuthorityRoutes } from './api/authority.js';

export { sourceEnvironmentRoutes } from './api/source-environments.js';
