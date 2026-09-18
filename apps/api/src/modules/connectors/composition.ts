import { randomUUID } from 'node:crypto';
import type { TenantDatabase } from '../platform/index.js';
import { createInstallationService as createService } from './application/installations.js';
import type { InstallationDependencies } from './application/installations.js';
import { createInstallationRepository } from './infrastructure/installation-repository.js';
import { createSecretCipher } from './infrastructure/secret-cipher.js';

import { installationBoundary } from './infrastructure/installation-validation.js';
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

export function createInstalledConnections(
  db: TenantDatabase,
  options: Pick<InstallationDependencies, 'refreshContext' | 'verify'> & {
    activeKeyId: string;
    keys: ReadonlyMap<string, Uint8Array>;
  },
) {
  return createInstallationService({
    repository: createInstallationRepository(db),
    cipher: createSecretCipher(options.activeKeyId, options.keys),
    refreshContext: options.refreshContext,
    verify: options.verify,
    id: randomUUID,
    now: () => new Date(),
  });
}
export { createInstalledRuntime } from './infrastructure/installed-runtime.js';
export type { InstalledRuntimeOptions } from './infrastructure/installed-runtime.js';
export { createSecretCipher };
export function createInstallationService(
  deps: Omit<InstallationDependencies, 'boundary'>,
) {
  return createService({ ...deps, boundary: installationBoundary });
}
export type { StoredInstallation } from './application/installations.js';
export { createShippingMethodEffects } from './application/shipping-method-effects.js';
export type { ShippingMethodEffectBinding } from './application/shipping-method-effects.js';

export { connectionRoutes } from './api/installations.js';
