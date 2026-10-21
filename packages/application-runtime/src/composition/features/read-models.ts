import {
  changeRoutes,
  customerRoutes,
  decisionRoutes,
  evidenceRoutes,
  fulfillmentRoutes,
  insightRoutes,
  inventoryRoutes,
  metricRoutes,
  orderRoutes,
  procurementContextRoutes,
  productRoutes,
  recordRoutes,
  returnRoutes,
} from '@luma/read-models/http';

import { createTenantFeatureRelease } from '../feature-release.js';
import type { AppDependencies } from '../http-app.js';

/** Implements the routes `@luma/read-models` serves. Missing services answer as unavailable. */
export function readModelsHttp(services: AppDependencies) {
  return {
    changes: changeRoutes(services.changes),
    customers: customerRoutes(services.customers),
    decisions: decisionRoutes(services.decisions, services.decisionAssignments),
    evidence: evidenceRoutes(services.evidence),
    fulfillment: fulfillmentRoutes(services.fulfillment),
    insights: insightRoutes(services.insights),
    inventory: inventoryRoutes(services.inventory),
    metrics: metricRoutes(
      services.metrics,
      services.operationalSummary,
      (tenantId) =>
        createTenantFeatureRelease(services.observability)(
          tenantId,
          'resolution-insights',
        ),
    ),
    orders: orderRoutes(services.orders),
    procurementContext: procurementContextRoutes(services.procurementContext),
    products: productRoutes(services.products),
    records: recordRoutes(services.records),
    returns: returnRoutes(services.returns),
  };
}
