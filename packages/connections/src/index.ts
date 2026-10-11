export type { ProviderCatalog } from './application/providers.js';

export { authorityGroups, resolveAuthority } from './domain/authority.js';

export type {
  AuthorityConnection,
  AuthorityOverrides,
  FactAuthority,
} from './domain/authority.js';

export type {
  AuthorityReader,
  AuthoritySettings,
  AuthoritySnapshot,
} from './application/authority.js';

export type {
  EffectIntent,
  EffectRegistry,
  VerificationResult,
} from './application/effects.js';

export { ConnectorError } from './domain/capabilities.js';

export type {
  CapabilityInput,
  CapabilityOutput,
  CapabilityResult,
  ConnectorFailure,
  CustomerSnapshot,
  ExternalId,
  FulfillmentSnapshot,
  HistoryLimit,
  InventorySnapshot,
  Observation,
  OrderSnapshot,
  Page,
  ProductSnapshot,
  ReadCapability,
  RefundSnapshot,
  ReturnSnapshot,
  SourceIdentity,
  SupplierOrderSnapshot,
  SupplierOrderStatus,
  SupplierSnapshot,
  WriteCapability,
} from './domain/capabilities.js';

export type {
  CapabilityReader,
  CapabilityRequest,
} from './application/capabilities.js';

export type {
  InstallationCapability,
  InstallationTarget,
  InstalledConnection,
} from './domain/installation.js';

export type { ConnectionManagement } from './application/installations.js';

export type {
  CommerceObservation,
  SourceRecords,
} from './application/source-records.js';

export type { CoverageReader } from './application/coverage.js';

export type {
  PlaybookGrantReader,
  PlaybookGrantSource,
} from './application/playbook-grants.js';

export type {
  CapabilityHandler,
  ConnectorConnection,
  InvocationContext,
} from './application/capabilities.js';

export type {
  InstallationDependencies,
  InstallationService,
  StoredInstallation,
  SecretCipher,
} from './application/installations.js';

export { secretBinding } from './application/installations.js';

export type { InstallationCredentials } from './domain/installation.js';

export { createShippingMethodEffects } from './application/shipping-method-effects.js';

export type { ConnectionProvider } from './application/provider.js';

export {
  connectionMetricDefinitions,
  summarizeConnectionMetrics,
} from './domain/metrics.js';

export type { ConnectionMetricItem } from './domain/metrics.js';
