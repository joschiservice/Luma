import { systemContract } from './contracts/system.js';
import { adaptiveContracts } from './domains/adaptive.js';
import { appHostContracts } from './domains/app-host.js';
import { assistantContracts } from './domains/assistant.js';
import { commerceSyncContracts } from './domains/commerce-sync.js';
import { connectionsContracts } from './domains/connections.js';
import { customersContracts } from './domains/customers.js';
import { exceptionsContracts } from './domains/exceptions.js';
import { identityContracts } from './domains/identity.js';
import { inventoryContracts } from './domains/inventory.js';
import { messagingContracts } from './domains/messaging.js';
import { ordersContracts } from './domains/orders.js';
import { policiesContracts } from './domains/policies.js';
import { procurementContracts } from './domains/procurement.js';
import { readModelsContracts } from './domains/read-models.js';
import { resolutionContracts } from './domains/resolution.js';
import { salesContracts } from './domains/sales.js';
import { workflowsContracts } from './domains/workflows.js';

/**
 * The route record's type, named so declaration output references each area's contract instead
 * of expanding every route schema into one type that exceeds the compiler's serialization limit.
 * Add an area to the group of the package that serves it, in `domains`.
 */
type ApiContract = typeof adaptiveContracts &
  typeof appHostContracts &
  typeof assistantContracts &
  typeof commerceSyncContracts &
  typeof connectionsContracts &
  typeof customersContracts &
  typeof exceptionsContracts &
  typeof identityContracts &
  typeof inventoryContracts &
  typeof messagingContracts &
  typeof ordersContracts &
  typeof policiesContracts &
  typeof procurementContracts &
  typeof readModelsContracts &
  typeof resolutionContracts &
  typeof salesContracts &
  typeof workflowsContracts & {
    system: typeof systemContract;
  };

/**
 * Every customer API route, keyed by area. Route keys form OpenAPI operation IDs, such as
 * `orders.list`.
 */
export const apiContract: ApiContract = {
  ...adaptiveContracts,
  ...appHostContracts,
  ...assistantContracts,
  ...commerceSyncContracts,
  ...connectionsContracts,
  ...customersContracts,
  ...exceptionsContracts,
  ...identityContracts,
  ...inventoryContracts,
  ...messagingContracts,
  ...ordersContracts,
  ...policiesContracts,
  ...procurementContracts,
  ...readModelsContracts,
  ...resolutionContracts,
  ...salesContracts,
  ...workflowsContracts,
  system: systemContract,
};

export * from './action-diff.js';

export * from './activity.js';

export * from './adaptive-actions.js';

export * from './adaptive-fields.js';

export * from './adaptive-packages.js';

export * from './adaptive-view-query.js';

export * from './adaptive-views.js';

export { apiAppLifetimeDays } from './contracts/api-apps.js';

export type { ApiApp } from './contracts/api-apps.js';

export * from './apps.js';

export { shopifyAccessSchema } from './apps.js';

export * from './assistant.js';

export * from './authority.js';

export * from './cases.js';

export * from './code-steps.js';

export * from './collection-catalog.js';

export * from './collection-catalogs.js';

export * from './collections.js';

export {
  anyMember,
  apiErrorSchema,
  organizationParamsSchema,
} from './common.js';

export type { ApiError, RouteAccess } from './common.js';

/** @public Declaration emit names it in the inferred types of the oRPC routes in each domain package. */
export type { RouteMeta } from './common.js';

export * from './connections.js';

export {
  caseEventsContract,
  metricEventsContract,
  workspaceTopics,
} from './contracts/events.js';

export type { WorkspaceTopic } from './contracts/events.js';

export { organizationSchema } from './contracts/identity.js';

export type {
  Membership,
  SecurityEventResponse,
  SupportViewState,
  TenantContextResponse,
} from './contracts/identity.js';

export * from './changes.js';

export * from './customers.js';

export * from './decisions.js';

export * from './desk.js';

export { diagnosisSchema } from './diagnosis.js';

export type { Diagnosis } from './diagnosis.js';

export * from './draft-tests.js';

export * from './evidence.js';

export * from './fulfillment.js';

export * from './incoming-stock.js';

export * from './insights.js';

export * from './inventory-transfers.js';

export * from './inventory.js';

export * from './layout.js';

export * from './learning.js';

export * from './measurement.js';

export * from './messaging.js';

export * from './metric-summary.js';

export * from './metrics.js';

export * from './native-stock.js';

export * from './operational-metrics.js';

export * from './orders.js';

export * from './overview.js';

export * from './playbooks.js';

export * from './procurement.js';

export * from './products.js';

export type { PurchaseOrderChangeInput } from './purchase-order-changes.js';

export * from './purchasing-outcomes.js';

export * from './purchasing.js';

export * from './records.js';

export * from './replenishment.js';

export type { ReturnActionView, ReturnActionList } from './return-actions.js';

export * from './return-cases.js';

export type {
  ReturnDeadlinePolicyView,
  ReturnWaitingView,
} from './return-deadlines.js';

export type { ReturnExchangesView } from './return-exchanges.js';

export * from './returns.js';

export * from './roles.js';

export { contractRoutes } from './routes.js';

export * from './sales.js';

export * from './scoped-autonomy.js';

export * from './settings.js';

export * from './shadow.js';

export * from './stock-protection.js';

export * from './supplier-email.js';

export { supplierTermsInputSchema } from './supplier-terms.js';

export type {
  SupplierProductTerms,
  SupplierTermsInput,
} from './supplier-terms.js';

export * from './sync.js';

export * from './workflow-drafts.js';

export * from './workflow-generation.js';

export * from './workflows.js';
