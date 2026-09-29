export type { Provider, ProviderCatalog } from './application/providers.js';

export type {
  EffectAdapter,
  EffectIntent,
  EffectRegistry,
  VerificationResult,
} from './application/effects.js';

export { ConnectorError } from './domain/capabilities.js';

export type {
  Capability,
  CapabilityContract,
  CapabilityInput,
  CapabilityOutput,
  CapabilityResult,
  ConnectorErrorCode,
  ConnectorFailure,
  CustomerSnapshot,
  ExternalId,
  FulfillmentSnapshot,
  HistoryLimit,
  InventorySnapshot,
  Money,
  Observation,
  OrderSnapshot,
  Page,
  PageQuery,
  ProductSnapshot,
  Quantity,
  ReadCapability,
  ShippingMethodSnapshot,
  SourceIdentity,
  WriteCapability,
  WriteReceipt,
} from './domain/capabilities.js';

export type {
  CapabilityDescriptor,
  CapabilityEvent,
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
  SourceMapping,
  SourceRecords,
} from './application/source-records.js';

export type { CoverageReader } from './application/coverage.js';

export type {
  PlaybookGrantReader,
  PlaybookGrantSource,
} from './application/playbook-grants.js';

export type {
  CapabilityDependencies,
  CapabilityHandler,
  ConnectorConnection,
  InvocationContext,
} from './application/capabilities.js';

export type {
  InstallationDependencies,
  InstallationService,
  InstallationRepository,
  StoredInstallation,
  SecretCipher,
} from './application/installations.js';

export { secretBinding } from './application/installations.js';

export type {
  InstallationInput,
  InstallationCredentials,
} from './domain/installation.js';

export { createShippingMethodEffects } from './application/shipping-method-effects.js';

export type {
  ConnectionProvider,
  ConnectorEvidence,
  ProviderRuntimeOptions,
} from './application/provider.js';

export {
  connectionMetricDefinitions,
  summarizeConnectionMetrics,
} from './domain/metrics.js';

export type { ConnectionMetricItem } from './domain/metrics.js';
