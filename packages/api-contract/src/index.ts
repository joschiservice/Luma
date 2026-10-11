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
import { ordersContract } from './contracts/orders.js';
import { operationsContract } from './contracts/overview.js';
import { playbooksContract } from './contracts/playbooks.js';
import { procurementContract } from './contracts/procurement.js';
import { procurementContextContract } from './contracts/procurement-context.js';
import { productsContract } from './contracts/products.js';
import { connectorProvidersContract } from './contracts/providers.js';
import { recordsContract } from './contracts/records.js';
import { returnsContract } from './contracts/returns.js';
import { rolesContract } from './contracts/roles.js';
import { settingsContract } from './contracts/settings.js';
import { shadowContract } from './contracts/shadow.js';
import { syncContract } from './contracts/sync.js';
import { systemContract } from './contracts/system.js';
import { workflowDraftsContract } from './contracts/workflow-drafts.js';
import { workflowGenerationContract } from './contracts/workflow-generation.js';
import { workflowsContract } from './contracts/workflows.js';

/**
 * Every customer API route, keyed by area. Route keys form OpenAPI operation IDs, such as
 * `orders.list`.
 */
export const apiContract = {
  shadow: shadowContract,
  activity: activityContract,
  playbooks: playbooksContract,
  workflows: workflowsContract,
  workflowDrafts: workflowDraftsContract,
  workflowGeneration: workflowGenerationContract,
  draftTests: draftTestsContract,
  procurement: procurementContract,
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
  products: productsContract,
  orders: ordersContract,
  returns: returnsContract,
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

export { diagnosisSchema } from './diagnosis.js';

export type { Diagnosis } from './diagnosis.js';

export {
  anyMember,
  apiErrorSchema,
  dataRegionSchema,
  organizationParamsSchema,
  requires,
} from './common.js';

export type {
  ApiError,
  ErrorStatus,
  RouteAccess,
  RouteMeta,
} from './common.js';

export { contractRoutes } from './routes.js';

export type { ContractRoute } from './routes.js';

export {
  membershipSchema,
  organizationSchema,
  securityEventSchema,
  supportViewStateSchema,
  tenantContextSchema,
} from './contracts/identity.js';

export type {
  Membership,
  SecurityEventResponse,
  SupportViewState,
  TenantContextResponse,
} from './contracts/identity.js';

export * from './roles.js';

export { connectorProviderSchema } from './contracts/providers.js';

export type { ConnectorProvider } from './contracts/providers.js';

export {
  caseEventsContract,
  metricEventsContract,
  metricStreamEventSchema,
  workspaceTopics,
  workspaceTopicSchema,
} from './contracts/events.js';

export type { EventStreamRoute, WorkspaceTopic } from './contracts/events.js';

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

export * from './fulfillment.js';

export * from './products.js';

export * from './returns.js';

export * from './customers.js';

export * from './sync.js';

export * from './decisions.js';

export * from './insights.js';

export * from './assistant.js';

export * from './messaging.js';
