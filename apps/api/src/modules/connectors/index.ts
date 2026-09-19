export type {
  Provider,
  ProviderCatalog,
} from '#modules/connectors/application/providers';
export type {
  EffectAdapter,
  EffectRegistry,
  EffectIntent,
  VerificationResult,
} from '#modules/connectors/application/effects';
export { ConnectorError } from '#modules/connectors/domain/capabilities';
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
  ShippingMethodSnapshot,
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
} from '#modules/connectors/domain/capabilities';
export { createCapabilityRuntime } from '#modules/connectors/application/capabilities';
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
} from '#modules/connectors/application/capabilities';
export type {
  InstalledConnection,
  InstallationCapability,
  InstallationTarget,
} from '#modules/connectors/domain/installation';
export type ConnectionManagement = Omit<
  import('#modules/connectors/application/installations').InstallationService,
  'credential' | 'recordFailure'
>;

export type {
  SourceRecords,
  CommerceObservation,
} from '#modules/connectors/application/source-records';

export type { CoverageReader } from '#modules/connectors/application/coverage';
