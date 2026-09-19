import type { ShopifyAppConfig as ShopifyConfig } from '#modules/connectors/application/shopify';
import { createShopifyOAuth } from '#modules/connectors/infrastructure/shopify/oauth';
import { randomUUID } from 'node:crypto';
import type { TenantDatabase } from '#modules/platform/index';
import { createInstallationService as createService } from '#modules/connectors/application/installations';
import type { InstallationDependencies } from '#modules/connectors/application/installations';
import { createInstallationRepository } from '#modules/connectors/infrastructure/installation-repository';
import { createSecretCipher } from '#modules/connectors/infrastructure/secret-cipher';

import { installationBoundary } from '#modules/connectors/infrastructure/installation-validation';
import { createProviderCatalog } from '#modules/connectors/application/providers';
import type { ProviderCatalog } from '#modules/connectors/application/providers';
import { createProviderRoutes } from '#modules/connectors/api/routes';

export function createConnectors(
  catalog: ProviderCatalog = createProviderCatalog(),
) {
  return createProviderRoutes(catalog);
}

export { createShopifyConnector } from '#modules/connectors/infrastructure/shopify/adapter';
export type {
  ShopifyConnectorOptions,
  ShopifyEvidence,
} from '#modules/connectors/infrastructure/shopify/adapter';
export { mapShopifyWebhook } from '#modules/connectors/infrastructure/shopify/webhooks';

export { createJtlConnector } from '#modules/connectors/infrastructure/jtl/adapter';
export type {
  JtlConnectorOptions,
  JtlEvidence,
} from '#modules/connectors/infrastructure/jtl/adapter';
export type { JtlConnection } from '#modules/connectors/infrastructure/jtl/client';

export function createInstalledConnections(
  db: TenantDatabase,
  options: Pick<InstallationDependencies, 'refreshContext' | 'verify'> & {
    shopify?: ShopifyConfig;
    activeKeyId: string;
    keys: ReadonlyMap<string, Uint8Array>;
  },
) {
  const cipher = createSecretCipher(options.activeKeyId, options.keys);
  const shopify = options.shopify
    ? createShopifyOAuth(db, options.shopify, {
        cipher,
        refreshContext: options.refreshContext,
        verify: options.verify,
      })
    : undefined;
  const service = createInstallationService({
    ...(shopify ? { shopifyCredential: shopify.credential } : {}),
    repository: createInstallationRepository(db),
    cipher,
    refreshContext: options.refreshContext,
    verify: options.verify,
    id: randomUUID,
    now: () => new Date(),
  });
  return { ...service, shopify };
}
export { createInstalledRuntime } from '#modules/connectors/infrastructure/installed-runtime';
export type { InstalledRuntimeOptions } from '#modules/connectors/infrastructure/installed-runtime';
export { createSecretCipher };
export function createInstallationService(
  deps: Omit<InstallationDependencies, 'boundary'>,
) {
  return createService({ ...deps, boundary: installationBoundary });
}
export type { StoredInstallation } from '#modules/connectors/application/installations';
export { createShippingMethodEffects } from '#modules/connectors/application/shipping-method-effects';
export type { ShippingMethodEffectBinding } from '#modules/connectors/application/shipping-method-effects';

export { connectionRoutes } from '#modules/connectors/api/installations';

export { createInstallationVerifier } from '#modules/connectors/infrastructure/installation-verifier';

export { registerShopifyRoutes } from '#modules/connectors/api/shopify';
export { createShopifyOAuth };
export type { ShopifyOAuth } from '#modules/connectors/infrastructure/shopify/oauth';
export { createSourceRecords } from '#modules/connectors/infrastructure/source-records';
