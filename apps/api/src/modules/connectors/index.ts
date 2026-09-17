export type { Provider, ProviderCatalog } from './application/providers.js';
export type {
  EffectAdapter,
  EffectRegistry,
  EffectIntent,
  VerificationResult,
} from './application/effects.js';
export { ConnectorError } from './domain/capabilities.js';
export type {
  ExternalId,
  SourceIdentity,
  Observation,
  PageQuery,
  Page,
  Quantity,
  OrderSnapshot,
  InventorySnapshot,
  FulfillmentSnapshot,
  ProductSnapshot,
  WriteReceipt,
  CapabilityContract,
  Capability,
  ReadCapability,
  WriteCapability,
  CapabilityInput,
  CapabilityOutput,
  ConnectorErrorCode,
  ConnectorFailure,
  CapabilityResult,
} from './domain/capabilities.js';
export { createCapabilityRuntime } from './application/capabilities.js';
export type {
  CapabilityDescriptor,
  InvocationContext,
  CapabilityHandler,
  ConnectorConnection,
  CapabilityEvent,
  CapabilityDependencies,
  CapabilityRequest,
  WriteRequest,
  CapabilityRuntime,
  CapabilityReader,
} from './application/capabilities.js';
export type {
  InstalledConnection,
  InstallationTarget,
} from './domain/installation.js';
export type ConnectionManagement = Omit<
  import('./application/installations.js').InstallationService,
  'credential'
>;
