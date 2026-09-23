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
  ExternalId,
  FulfillmentSnapshot,
  InventorySnapshot,
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
  SourceRecords,
} from './application/source-records.js';

export type { CoverageReader } from './application/coverage.js';

export type {
  PlaybookGrantReader,
  PlaybookGrantSource,
} from './application/playbook-grants.js';
