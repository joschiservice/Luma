import { randomUUID } from 'node:crypto';

import type { TenantDatabase } from '@luma/platform';

import type { InstallationDependencies } from './application/installations.js';
import { createInstallationService as createService } from './application/installations.js';
import type { ShopifyAppConfig as ShopifyConfig } from './application/shopify.js';
import { createInstallationRepository } from './infrastructure/installations/repository.js';
import { createSecretCipher } from './infrastructure/installations/secret-cipher.js';
import { installationBoundary } from './infrastructure/installations/validation.js';
import { createShopifyOAuth } from './infrastructure/shopify/oauth.js';

export type {
  ShopifyConnectorOptions,
  ShopifyEvidence,
} from './infrastructure/shopify/adapter.js';

export { mapShopifyWebhook } from './infrastructure/shopify/webhooks.js';

export type {
  JtlConnectorOptions,
  JtlEvidence,
} from './infrastructure/jtl/adapter.js';

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
} from './infrastructure/installations/runtime.js';

export type { InstalledRuntimeOptions } from './infrastructure/installations/runtime.js';

export { createSecretCipher };

/** Creates connection lifecycle commands with the standard installation validators. */
export function createInstallationService(
  deps: Omit<InstallationDependencies, 'boundary'>,
) {
  return createService({ ...deps, boundary: installationBoundary });
}

export type { StoredInstallation } from './application/installations.js';

export { createShippingMethodEffects } from './application/shipping-method-effects.js';

export type { ShippingMethodEffectBinding } from './application/shipping-method-effects.js';

export { createInstallationVerifier } from './infrastructure/installations/verifier.js';

export { createShopifyOAuth };

export type { ShopifyOAuth } from './infrastructure/shopify/oauth.js';

export { createSourceRecords } from './infrastructure/source-records.js';

export { createConnectionCoverage } from './infrastructure/coverage.js';

export { createSimulationTransport } from './infrastructure/installations/simulation.js';

export type { SimulationTransport } from './infrastructure/installations/simulation.js';

export { createReadChecks } from './infrastructure/read-checks.js';

export { createPlaybookGrantReader } from './infrastructure/playbook-grants.js';
