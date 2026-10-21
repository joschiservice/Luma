import { changesContract } from '../contracts/changes.js';
import { customersContract } from '../contracts/customers.js';
import { decisionsContract } from '../contracts/decisions.js';
import { evidenceContract } from '../contracts/evidence.js';
import { fulfillmentContract } from '../contracts/fulfillment.js';
import { insightsContract } from '../contracts/insights.js';
import { inventoryContract } from '../contracts/inventory.js';
import { metricsContract } from '../contracts/metrics.js';
import { ordersContract } from '../contracts/orders.js';
import { procurementContextContract } from '../contracts/procurement-context.js';
import { productsContract } from '../contracts/products.js';
import { recordsContract } from '../contracts/records.js';
import { returnsContract } from '../contracts/returns.js';

/** Routes served by `@luma/read-models`. */
type ReadModelsContracts = {
  changes: typeof changesContract;
  customers: typeof customersContract;
  decisions: typeof decisionsContract;
  evidence: typeof evidenceContract;
  fulfillment: typeof fulfillmentContract;
  insights: typeof insightsContract;
  inventory: typeof inventoryContract;
  metrics: typeof metricsContract;
  orders: typeof ordersContract;
  procurementContext: typeof procurementContextContract;
  products: typeof productsContract;
  records: typeof recordsContract;
  returns: typeof returnsContract;
};

/** Routes served by `@luma/read-models`, keyed by area. */
export const readModelsContracts: ReadModelsContracts = {
  changes: changesContract,
  customers: customersContract,
  decisions: decisionsContract,
  evidence: evidenceContract,
  fulfillment: fulfillmentContract,
  insights: insightsContract,
  inventory: inventoryContract,
  metrics: metricsContract,
  orders: ordersContract,
  procurementContext: procurementContextContract,
  products: productsContract,
  records: recordsContract,
  returns: returnsContract,
};
