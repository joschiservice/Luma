import { createProviderCatalog } from './application/providers.js';
import type { ProviderCatalog } from './application/providers.js';
import { createProviderRoutes } from './api/routes.js';

export function createConnectors(
  catalog: ProviderCatalog = createProviderCatalog(),
) {
  return createProviderRoutes(catalog);
}

export { createShopifyConnector } from './infrastructure/shopify/adapter.js';
export type {
  ShopifyConnectorOptions,
  ShopifyEvidence,
} from './infrastructure/shopify/adapter.js';
export { mapShopifyWebhook } from './infrastructure/shopify/webhooks.js';

export { createJtlConnector } from './infrastructure/jtl/adapter.js';
export type {
  JtlConnectorOptions,
  JtlEvidence,
} from './infrastructure/jtl/adapter.js';
export type { JtlConnection } from './infrastructure/jtl/client.js';
