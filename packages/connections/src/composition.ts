import { randomUUID } from 'node:crypto';

import type { TenantDatabase } from '@luma/platform';

import type { InstallationDependencies } from './application/installations.js';
import { createInstallationService as createService } from './application/installations.js';
import { createInstallationRepository } from './infrastructure/installations/repository.js';
import { createSecretCipher } from './infrastructure/installations/secret-cipher.js';
import { installationBoundary } from './infrastructure/installations/validation.js';

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

export {
  createInstalledPurchaseOrderRuntime,
  createInstalledRuntime,
  createInstalledShippingMethodEffects,
} from './infrastructure/installations/runtime.js';

export type {
  InstalledPurchaseOrderRuntime,
  InstalledRuntimeOptions,
} from './infrastructure/installations/runtime.js';

export type { StoredInstallation } from './application/installations.js';

export { createShippingMethodEffects } from './application/shipping-method-effects.js';

export type { ShippingMethodEffectBinding } from './application/shipping-method-effects.js';

export { createSourceRecords } from './infrastructure/source-records.js';

export { createConnectionCoverage } from './infrastructure/coverage.js';

export { createSimulationTransport } from './infrastructure/installations/simulation.js';

export type { SimulationTransport } from './infrastructure/installations/simulation.js';

export { createReadChecks } from './infrastructure/read-checks.js';

export { createPlaybookGrantReader } from './infrastructure/playbook-grants.js';

export { createProductIdentityReader } from './infrastructure/product-identities.js';

export { createProviderCatalog } from './application/providers.js';

export { commerceSchema } from './infrastructure/source-validation.js';
