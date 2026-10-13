export type {
  CanonicalSnapshot,
  CommerceProjections,
  MoneyPair,
  OrderCommercialData,
  OrderLineCommercialData,
  RefundData,
  ReturnData,
} from './application/projections.js';

export { stageGroups } from './domain/returns.js';

export type { RefundState, ReturnStage, StageGroup } from './domain/returns.js';

export { orderMetricDefinitions, orderMetricIds } from './domain/metrics.js';

export type { OrderMetricId } from './domain/metrics.js';

export type {
  OrderMetricScope,
  OrderMetricRead,
  OrderMetricReader,
} from './application/metrics.js';

export type { OrderStateQueries } from './application/order-state.js';

export type { ReturnCaseAttention } from './application/return-cases.js';

export type {
  ComparisonState,
  ComparisonDifference,
} from './domain/source-comparison.js';

export {
  lineComparisonKeys,
  orderComparisonPolicy,
  orderComparisonState,
  sharedComparisonLines,
} from './domain/source-comparison.js';

export {
  settlementRefundProgress,
  toUnits,
  fromUnits,
} from './domain/returns.js';

export type { JourneyEvent, OrderJourney } from './domain/journey.js';

export { journeyTiming } from './domain/journey.js';

export {
  OrderChangeRequestError,
  orderChangeCapabilities,
  planOrderChanges,
} from './domain/order-change-plan.js';

export type {
  OrderChangePlan,
  OrderChangeRequest,
  PlanSource,
} from './domain/order-change-plan.js';
