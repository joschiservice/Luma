export { canonicalJson } from './domain/canonical-json.js';

export type {
  ActivityFailureContext,
  FailureContext,
  FeatureFlag,
  HttpFailureContext,
  Observability,
  Observation,
  Operation,
  ProductEvent,
  TraceContext,
} from './application/observability.js';

export {
  createFailureLog,
  describeError,
} from './application/error-details.js';

export type { ErrorDetails } from './application/error-details.js';

export type { SqlTransaction, TenantDatabase } from './application/database.js';

export {
  authoringModelProfile,
  ModelGatewayError,
} from './application/model-gateway.js';

export type {
  JsonValue,
  ModelAdapter,
  ModelAdapterId,
  ModelDataPolicy,
  ModelErrorCode,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelResult,
  ModelRoute,
  ModelRoutingPolicy,
  ModelSchema,
  ModelTool,
  ModelToolCall,
  ModelUsage,
} from './application/model-gateway.js';

export { measure, measureSync } from './application/performance.js';

export type {
  OperationalMetricDefinition,
  OperationalMetricRead,
} from './domain/metric.js';
