import { createHash, randomUUID } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import { createAuthorityService } from './application/authority.js';
import type { InstallationDependencies } from './application/installations.js';
import { createInstallationService as createService } from './application/installations.js';
import { createSourceEnvironments } from './application/source-environment.js';
import type { AuthorityConnection } from './domain/authority.js';
import { createAuthorityRepository } from './infrastructure/authority.js';
import { createInstallationRepository } from './infrastructure/installations/repository.js';
import { createSecretCipher } from './infrastructure/installations/secret-cipher.js';
import { installationBoundary } from './infrastructure/installations/validation.js';
import { createSourceEnvironmentRepository } from './infrastructure/source-environment.js';

/** Creates persisted workspace authority using the installed provider catalog's categories. */
export function createSourceAuthority(
  db: TenantDatabase,
  category: (provider: string) => AuthorityConnection['category'],
  refreshContext: (context: TenantContext) => Promise<TenantContext>,
  internalOrdersEnabled?: (tenantId: string) => Promise<boolean>,
) {
  return createAuthorityService(
    createAuthorityRepository(db, category, internalOrdersEnabled),
    refreshContext,
  );
}

/** Creates persistent connection management with encrypted app-owned credentials. */
export function createInstalledConnections(
  db: TenantDatabase,
  options: Pick<
    InstallationDependencies,
    | 'refreshContext'
    | 'verify'
    | 'provider'
    | 'validate'
    | 'validateCredentials'
    | 'refreshCredential'
  > & { activeKeyId: string; keys: ReadonlyMap<string, Uint8Array> },
) {
  return createInstallationService({
    ...options,
    repository: createInstallationRepository(db),
    cipher: createSecretCipher(options.activeKeyId, options.keys),
    id: randomUUID,
    now: () => new Date(),
  });
}

/** Creates connection lifecycle commands with shared envelope validation. */
export function createInstallationService(
  deps: Omit<InstallationDependencies, 'boundary'>,
) {
  return createService({ ...deps, boundary: installationBoundary });
}

export { createSecretCipher, createInstallationRepository };

export { createOrderSourceVisibility } from './infrastructure/source-visibility.js';

export { createInternalOrderSource } from './infrastructure/internal-source.js';

export {
  createInstalledMessageRuntime,
  createInstalledPurchaseOrderRuntime,
  createInstalledReturnRuntime,
  createInstalledRuntime,
  createInstalledShippingMethodEffects,
} from './infrastructure/installations/runtime.js';

export type {
  InstalledMessageRuntime,
  InstalledPurchaseOrderRuntime,
  MessageSendBinding,
  InstalledReturnRuntime,
} from './infrastructure/installations/runtime.js';

export type { StoredInstallation } from './application/installations.js';

export { createShippingMethodEffects } from './application/shipping-method-effects.js';

export { createSourceRecords } from './infrastructure/source-records.js';

export { createConnectionCoverage } from './infrastructure/coverage.js';

export { createSimulationTransport } from './infrastructure/installations/simulation.js';

export type { SimulationTransport } from './infrastructure/installations/simulation.js';

export { createReadChecks } from './infrastructure/read-checks.js';

export { createOrderReadChecks } from './infrastructure/order-read-checks.js';

export { createPlaybookGrantReader } from './infrastructure/playbook-grants.js';

export { createProductIdentityReader } from './infrastructure/product-identities.js';

export { createProviderCatalog } from './application/providers.js';

export { commerceSchema } from './infrastructure/source-validation.js';

export {
  transferSnapshotSchema,
  shipmentSnapshotSchema,
} from './infrastructure/transfer-validation.js';

export {
  orderBundleGroupSchema,
  productBundleSchema,
  stockCompositionSchema,
} from './infrastructure/bundle-validation.js';

export { productPurchasingTermsSchema } from './infrastructure/purchasing-terms-validation.js';

export { purchaseOrderRevisionInputSchema } from './infrastructure/purchase-order-revision-validation.js';

/** Wires connection-owned source declarations with opaque exact-source binding and immutable storage. */
export function createSourceEnvironmentService(
  db: TenantDatabase,
  deps: Omit<
    Parameters<typeof createSourceEnvironments>[0],
    'repository' | 'binding' | 'fingerprint' | 'id' | 'now'
  >,
) {
  const hash = (value: unknown) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');

  return createSourceEnvironments({
    ...deps,
    repository: createSourceEnvironmentRepository(db),
    binding: (c) =>
      hash([
        c.tenantId,
        c.id,
        c.version,
        c.credentialVersion,
        c.appInstallationVersion ?? null,
        c.provider ?? c.target.kind,
        Object.entries(c.target).sort(([a], [b]) => a.localeCompare(b)),
      ]),
    fingerprint: hash,
    id: randomUUID,
    now: () => new Date(),
  });
}
