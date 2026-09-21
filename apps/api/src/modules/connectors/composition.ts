import { randomUUID } from 'node:crypto';

import { createProviderRoutes } from '#modules/connectors/api/routes';
import type { InstallationDependencies } from '#modules/connectors/application/installations';
import { createInstallationService as createService } from '#modules/connectors/application/installations';
import type { ProviderCatalog } from '#modules/connectors/application/providers';
import { createProviderCatalog } from '#modules/connectors/application/providers';
import type { ShopifyAppConfig as ShopifyConfig } from '#modules/connectors/application/shopify';
import { createInstallationRepository } from '#modules/connectors/infrastructure/installations/repository';
import { createSecretCipher } from '#modules/connectors/infrastructure/installations/secret-cipher';
import { installationBoundary } from '#modules/connectors/infrastructure/installations/validation';
import { createShopifyOAuth } from '#modules/connectors/infrastructure/shopify/oauth';
import type { TenantDatabase } from '#modules/platform/index';

/** Creates provider-catalog routes, using the built-in catalog unless one is supplied. */
export function createConnectors(
  catalog: ProviderCatalog = createProviderCatalog(),
) {
  return createProviderRoutes(catalog);
}

export type {
  ShopifyConnectorOptions,
  ShopifyEvidence,
} from '#modules/connectors/infrastructure/shopify/adapter';

export { mapShopifyWebhook } from '#modules/connectors/infrastructure/shopify/webhooks';

export type {
  JtlConnectorOptions,
  JtlEvidence,
} from '#modules/connectors/infrastructure/jtl/adapter';

export type { JtlConnection } from '@luma/connector-jtl';

/**
 * Creates persistent connection management with encrypted credentials and optional Shopify
 * OAuth support.
 */
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

export {
  createInstalledRuntime,
  createInstalledShippingMethodEffects,
} from '#modules/connectors/infrastructure/installations/runtime';

export type { InstalledRuntimeOptions } from '#modules/connectors/infrastructure/installations/runtime';

export { createSecretCipher };

/** Creates connection lifecycle commands with the standard installation validators. */
export function createInstallationService(
  deps: Omit<InstallationDependencies, 'boundary'>,
) {
  return createService({ ...deps, boundary: installationBoundary });
}

export type { StoredInstallation } from '#modules/connectors/application/installations';

export { createShippingMethodEffects } from '#modules/connectors/application/shipping-method-effects';

export type { ShippingMethodEffectBinding } from '#modules/connectors/application/shipping-method-effects';

export { connectionRoutes } from '#modules/connectors/api/installations';

export { createInstallationVerifier } from '#modules/connectors/infrastructure/installations/verifier';

export { registerShopifyRoutes } from '#modules/connectors/api/shopify';

export { createShopifyOAuth };

export type { ShopifyOAuth } from '#modules/connectors/infrastructure/shopify/oauth';

export { createSourceRecords } from '#modules/connectors/infrastructure/source-records';

export { createConnectionCoverage } from '#modules/connectors/infrastructure/coverage';

export { createSimulationTransport } from '#modules/connectors/infrastructure/installations/simulation';

export type { SimulationTransport } from '#modules/connectors/infrastructure/installations/simulation';

export { createReadChecks } from '#modules/connectors/infrastructure/read-checks';
