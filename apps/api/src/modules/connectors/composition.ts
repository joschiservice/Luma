import { createProviderCatalog } from './application/providers.js';
import type { ProviderCatalog } from './application/providers.js';
import { createProviderRoutes } from './api/routes.js';

export function createConnectors(
  catalog: ProviderCatalog = createProviderCatalog(),
) {
  return createProviderRoutes(catalog);
}
