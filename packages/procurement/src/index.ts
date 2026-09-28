export type { ProcurementService } from './application/procurement.js';

export type {
  Supplier,
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseOrderInput,
  SupplierInput,
  TransitionInput,
} from './domain/procurement.js';

export {
  planReplenishment,
  replenishmentSource,
} from './domain/replenishment.js';

export type { ReplenishmentRule } from './domain/replenishment.js';

export type {
  ReplenishmentActivation,
  ReplenishmentStock,
  ReplenishmentStore,
} from './application/replenishment.js';

export { createReplenishmentService } from './application/replenishment-workflow.js';

export type { ReplenishmentTransport } from './application/replenishment-workflow.js';

export {
  procurementMetricDefinitions,
  stockMetricDefinitions,
} from './domain/metrics.js';

export type {
  StockMetricItem,
  PurchaseOrderMetricItem,
} from './domain/metrics.js';
