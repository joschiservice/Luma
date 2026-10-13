import { activityContract } from './contracts/activity.js';
import { appsContract } from './contracts/apps.js';
import { assistantContract } from './contracts/assistant.js';
import { sourceAuthorityContract } from './contracts/authority.js';
import { exceptionsContract } from './contracts/cases.js';
import { connectionsContract } from './contracts/connections.js';
import { customersContract } from './contracts/customers.js';
import { decisionsContract } from './contracts/decisions.js';
import { caseDeskContract } from './contracts/desk.js';
import { draftTestsContract } from './contracts/draft-tests.js';
import { fulfillmentContract } from './contracts/fulfillment.js';
import { identityContract } from './contracts/identity.js';
import { insightsContract } from './contracts/insights.js';
import { inventoryContract } from './contracts/inventory.js';
import { resolutionLearningContract } from './contracts/learning.js';
import { messagingContract } from './contracts/messaging.js';
import { metricsContract } from './contracts/metrics.js';
import { nativeStockContract } from './contracts/native-stock.js';
import { ordersContract } from './contracts/orders.js';
import { operationsContract } from './contracts/overview.js';
import { playbooksContract } from './contracts/playbooks.js';
import { procurementContract } from './contracts/procurement.js';
import { procurementContextContract } from './contracts/procurement-context.js';
import { productsContract } from './contracts/products.js';
import { connectorProvidersContract } from './contracts/providers.js';
import { procurementChangesContract } from './contracts/purchase-order-changes.js';
import { recordsContract } from './contracts/records.js';
import { returnCasesContract } from './contracts/return-cases.js';
import { returnsContract } from './contracts/returns.js';
import { rolesContract } from './contracts/roles.js';
import { salesContract } from './contracts/sales.js';
import { settingsContract } from './contracts/settings.js';
import { shadowContract } from './contracts/shadow.js';
import { supplierEmailContract } from './contracts/supplier-email.js';
import { syncContract } from './contracts/sync.js';
import { systemContract } from './contracts/system.js';
import { workflowDraftsContract } from './contracts/workflow-drafts.js';
import { workflowGenerationContract } from './contracts/workflow-generation.js';
import { workflowsContract } from './contracts/workflows.js';

/**
 * The route record's type, named so declaration output references each area's contract instead
 * of expanding every route schema into one type that exceeds the compiler's serialization limit.
 */
type ApiContract = {
  shadow: typeof shadowContract;
  activity: typeof activityContract;
  playbooks: typeof playbooksContract;
  workflows: typeof workflowsContract;
  workflowDrafts: typeof workflowDraftsContract;
  workflowGeneration: typeof workflowGenerationContract;
  draftTests: typeof draftTestsContract;
  procurement: typeof procurementContract;
  procurementChanges: typeof procurementChangesContract;
  procurementEmail: typeof supplierEmailContract;
  procurementContext: typeof procurementContextContract;
  messaging: typeof messagingContract;
  resolutionLearning: typeof resolutionLearningContract;
  caseDesk: typeof caseDeskContract;
  operations: typeof operationsContract;
  metrics: typeof metricsContract;
  exceptions: typeof exceptionsContract;
  identity: typeof identityContract;
  settings: typeof settingsContract;
  roles: typeof rolesContract;
  connections: typeof connectionsContract;
  apps: typeof appsContract;
  system: typeof systemContract;
  connectorProviders: typeof connectorProvidersContract;
  records: typeof recordsContract;
  fulfillment: typeof fulfillmentContract;
  inventory: typeof inventoryContract;
  nativeStock: typeof nativeStockContract;
  products: typeof productsContract;
  orders: typeof ordersContract;
  sales: typeof salesContract;
  returns: typeof returnsContract;
  returnCases: typeof returnCasesContract;
  customers: typeof customersContract;
  sync: typeof syncContract;
  decisions: typeof decisionsContract;
  insights: typeof insightsContract;
  assistant: typeof assistantContract;
  sourceAuthority: typeof sourceAuthorityContract;
};

/**
 * Every customer API route, keyed by area. Route keys form OpenAPI operation IDs, such as
 * `orders.list`.
 */
export const apiContract: ApiContract = {
  shadow: shadowContract,
  activity: activityContract,
  playbooks: playbooksContract,
  workflows: workflowsContract,
  workflowDrafts: workflowDraftsContract,
  workflowGeneration: workflowGenerationContract,
  draftTests: draftTestsContract,
  procurement: procurementContract,
  procurementChanges: procurementChangesContract,
  procurementEmail: supplierEmailContract,
  procurementContext: procurementContextContract,
  messaging: messagingContract,
  resolutionLearning: resolutionLearningContract,
  caseDesk: caseDeskContract,
  operations: operationsContract,
  metrics: metricsContract,
  exceptions: exceptionsContract,
  identity: identityContract,
  settings: settingsContract,
  roles: rolesContract,
  connections: connectionsContract,
  apps: appsContract,
  system: systemContract,
  connectorProviders: connectorProvidersContract,
  records: recordsContract,
  fulfillment: fulfillmentContract,
  inventory: inventoryContract,
  nativeStock: nativeStockContract,
  products: productsContract,
  orders: ordersContract,
  sales: salesContract,
  returns: returnsContract,
  returnCases: returnCasesContract,
  customers: customersContract,
  sync: syncContract,
  decisions: decisionsContract,
  insights: insightsContract,
  assistant: assistantContract,
  sourceAuthority: sourceAuthorityContract,
};

export * from './activity.js';

export * from './learning.js';

export * from './desk.js';

export * from './overview.js';

export * from './measurement.js';

export * from './cases.js';

export * from './connections.js';

export * from './authority.js';

export * from './sales.js';

export { diagnosisSchema } from './diagnosis.js';

export type { Diagnosis } from './diagnosis.js';

export {
  anyMember,
  apiErrorSchema,
  dataRegionSchema,
  organizationParamsSchema,
} from './common.js';

export type { ApiError, RouteAccess } from './common.js';

/** @public Declaration emit names it in the inferred types of the oRPC routes in each domain package. */
export type { RouteMeta } from './common.js';

export { contractRoutes } from './routes.js';

export { organizationSchema } from './contracts/identity.js';

export type {
  Membership,
  SecurityEventResponse,
  SupportViewState,
  TenantContextResponse,
} from './contracts/identity.js';

export * from './roles.js';

export {
  caseEventsContract,
  metricEventsContract,
  workspaceTopics,
} from './contracts/events.js';

export type { WorkspaceTopic } from './contracts/events.js';

export * from './playbooks.js';

export * from './shadow.js';

export * from './layout.js';

export * from './settings.js';

export * from './apps.js';

export * from './workflows.js';

export * from './workflow-drafts.js';

export * from './workflow-generation.js';

export * from './draft-tests.js';

export * from './code-steps.js';

export * from './procurement.js';

export * from './replenishment.js';

export * from './metric-summary.js';

export * from './metrics.js';

export * from './operational-metrics.js';

export * from './records.js';

export * from './orders.js';

export * from './inventory.js';

export * from './inventory-transfers.js';

export * from './fulfillment.js';

export * from './products.js';

export * from './returns.js';

export * from './return-cases.js';

export * from './customers.js';

export * from './sync.js';

export * from './decisions.js';

export * from './insights.js';

export * from './assistant.js';

export * from './messaging.js';

export { shopifyAccessSchema } from './apps.js';

export type { ReturnActionView, ReturnActionList } from './return-actions.js';

export type { ReturnExchangesView } from './return-exchanges.js';

export type {
  ReturnDeadlinePolicyView,
  ReturnWaitingView,
} from './return-deadlines.js';

export * from './native-stock.js';

export { supplierTermsInputSchema } from './supplier-terms.js';

export type {
  SupplierProductTerms,
  SupplierTermsInput,
} from './supplier-terms.js';

export * from './supplier-email.js';

export * from './purchasing.js';

export * from './purchasing-outcomes.js';

export * from './incoming-stock.js';

export type { PurchaseOrderChangeInput } from './purchase-order-changes.js';
