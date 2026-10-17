import {
  createConnectionCoverage,
  type createOrderSourceVisibility,
  type createSourceAuthority,
} from '@luma/connections/composition';
import {
  caseTimelineQuery,
  createCaseMetricReader,
  createOrderAttentionBoundaryReader,
  orderAttentionForOrders,
  orderAttentionQuery,
} from '@luma/exceptions/composition';
import type { IdentityService } from '@luma/identity';
import {
  createOrderMetricReader,
  orderStateQueries,
} from '@luma/orders/composition';
import type { TenantDatabase } from '@luma/platform';
import {
  type createProcurement,
  createProcurementMetricReader,
  createStockRiskReader,
  type SupplierCommitments,
} from '@luma/procurement/composition';
import {
  createCustomerWorkspace,
  createFulfillmentWorkspace,
  createInsights,
  createInventoryWorkspace,
  createOperationalMetrics,
  createOperationalSummary,
  createOrderWorkspace,
  createProcurementContext,
  createProductWorkspace,
  createRecordExplorer,
  createReturnWorkspace,
} from '@luma/read-models/composition';
import {
  createActivityStore,
  createResolutionMetricReader,
} from '@luma/resolution/composition';

import type { createTenantFeatureRelease } from './feature-release.js';

/** The read-only workspace views, by the HTTP area that serves them. */
export interface ReadModelServices {
  customers: ReturnType<typeof createCustomerWorkspace>;
  fulfillment: ReturnType<typeof createFulfillmentWorkspace>;
  insights: ReturnType<typeof createInsights>;
  inventory: ReturnType<typeof createInventoryWorkspace>;
  metrics: ReturnType<typeof createOperationalMetrics>;
  operationalSummary: ReturnType<typeof createOperationalSummary>;
  orders: ReturnType<typeof createOrderWorkspace>;
  procurementContext: ReturnType<typeof createProcurementContext>;
  products: ReturnType<typeof createProductWorkspace>;
  records: ReturnType<typeof createRecordExplorer>;
  returns: ReturnType<typeof createReturnWorkspace>;
}

/**
 * Builds the read-only workspace views that read across owners' tables. They don't write and
 * hold no state, so any runtime can compose them after the owners they read.
 */
export function createReadModelServices(options: {
  database: TenantDatabase;
  identity: IdentityService;
  authority: (
    scoped: TenantDatabase,
  ) => ReturnType<typeof createSourceAuthority>;
  hiddenOrderSources: ReturnType<typeof createOrderSourceVisibility>;
  /** The permission a person needs to request a provider write through an app. */
  actionPermission?: (appId: string, capability: string) => string | null;
  commitments: SupplierCommitments;
  procurement: ReturnType<typeof createProcurement>;
  release: ReturnType<typeof createTenantFeatureRelease>;
}): ReadModelServices {
  const { database, identity, hiddenOrderSources } = options;
  const orderQueries = {
    state: orderStateQueries,
    attention: orderAttentionQuery,
    attentionFor: orderAttentionForOrders,
  };
  const orders = createOrderWorkspace(
    database,
    orderQueries,
    createActivityStore,
    identity.refreshContext,
    options.authority,
    undefined,
    hiddenOrderSources,
    options.actionPermission,
  );
  const fulfillment = createFulfillmentWorkspace(
    database,
    orderQueries,
    createActivityStore,
    identity.refreshContext,
  );
  const insights = createInsights(database, {
    orders: orderQueries,
    cases: caseTimelineQuery,
    stock: createStockRiskReader,
    procurement: async (context) => {
      const [summaries, { items }] = await Promise.all([
        options.commitments.summaries(context),
        options.procurement.orders(context),
      ]);
      const orders = new Map(items.map((order) => [order.id, order]));

      // Orders created between the two reads are left for the next refresh.
      return summaries.flatMap((summary) => {
        const order = orders.get(summary.id);

        return order
          ? [
              {
                id: summary.id,
                reference: order.reference,
                supplierName: order.supplierName,
                stage: summary.stage,
                expectedDate: summary.expectedDate,
                overdue: summary.overdue,
                attention: summary.attention,
                nextOwner: summary.nextOwner,
                createdAt: order.createdAt,
              },
            ]
          : [];
      });
    },
    refreshContext: identity.refreshContext,
  });

  return {
    customers: createCustomerWorkspace(database),
    fulfillment,
    insights,
    inventory: createInventoryWorkspace(database),
    metrics: createOperationalMetrics(database, {
      orders: (db) =>
        createOrderMetricReader(db, orderAttentionQuery, hiddenOrderSources),
      attentionBoundary: createOrderAttentionBoundaryReader,
      coverage: createConnectionCoverage,
    }),
    operationalSummary: createOperationalSummary(database, {
      resolutionInsightsEnabled: (tenantId) =>
        options.release(tenantId, 'resolution-insights'),
      cases: createCaseMetricReader,
      resolution: createResolutionMetricReader,
      procurement: createProcurementMetricReader,
      coverage: createConnectionCoverage,
    }),
    orders,
    procurementContext: createProcurementContext(database),
    products: createProductWorkspace(database),
    records: createRecordExplorer(database, hiddenOrderSources),
    returns: createReturnWorkspace(database),
  };
}
