export { canonicalJson } from './domain/canonical-json.js';

export { featureFlags } from './application/observability.js';

export type {
  FeatureFlag,
  Observability,
  Observation,
  Operation,
  TraceContext,
} from './application/observability.js';

export {
  createFailureLog,
  describeError,
} from './application/error-details.js';

export type { SqlTransaction, TenantDatabase } from './application/database.js';

export {
  authoringModelProfile,
  ModelGatewayError,
} from './application/model-gateway.js';

export type {
  JsonValue,
  ModelAdapter,
  ModelErrorCode,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelSchema,
  ModelTool,
  ModelUsage,
} from './application/model-gateway.js';

export { measure, measureSync } from './application/performance.js';

export type {
  OperationalMetricDefinition,
  OperationalMetricRead,
} from './domain/metric.js';

export type { AtomicStore } from './application/atomic-store.js';
