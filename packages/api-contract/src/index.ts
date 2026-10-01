import { initContract } from '@ts-rest/core';

import { apiErrorSchema } from './common.js';
import { activityContract } from './contracts/activity.js';
import { appsContract } from './contracts/apps.js';
import { exceptionsContract } from './contracts/cases.js';
import { connectionsContract } from './contracts/connections.js';
import { decisionsContract } from './contracts/decisions.js';
import { caseDeskContract } from './contracts/desk.js';
import { draftTestsContract } from './contracts/draft-tests.js';
import { fulfillmentContract } from './contracts/fulfillment.js';
import { identityContract } from './contracts/identity.js';
import { inventoryContract } from './contracts/inventory.js';
import { resolutionLearningContract } from './contracts/learning.js';
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
import { settingsContract } from './contracts/settings.js';
import { shadowContract } from './contracts/shadow.js';
import { syncContract } from './contracts/sync.js';
import { systemContract } from './contracts/system.js';
import { workflowDraftsContract } from './contracts/workflow-drafts.js';
import { workflowGenerationContract } from './contracts/workflow-generation.js';
import { workflowsContract } from './contracts/workflows.js';

const c: ReturnType<typeof initContract> = initContract();

const routes: {
  shadow: typeof shadowContract;
  activity: typeof activityContract;
  playbooks: typeof playbooksContract;
  workflows: typeof workflowsContract;
  workflowDrafts: typeof workflowDraftsContract;
  workflowGeneration: typeof workflowGenerationContract;
  draftTests: typeof draftTestsContract;
  procurement: typeof procurementContract;
  procurementContext: typeof procurementContextContract;
  resolutionLearning: typeof resolutionLearningContract;
  caseDesk: typeof caseDeskContract;
  operations: typeof operationsContract;
  metrics: typeof metricsContract;
  exceptions: typeof exceptionsContract;
  identity: typeof identityContract;
  settings: typeof settingsContract;
  connections: typeof connectionsContract;
  apps: typeof appsContract;
  system: typeof systemContract;
  connectorProviders: typeof connectorProvidersContract;
  records: typeof recordsContract;
  fulfillment: typeof fulfillmentContract;
  inventory: typeof inventoryContract;
  products: typeof productsContract;
  orders: typeof ordersContract;
  returns: typeof returnsContract;
  sync: typeof syncContract;
  decisions: typeof decisionsContract;
} = {
  shadow: shadowContract,
  activity: activityContract,
  playbooks: playbooksContract,
  workflows: workflowsContract,
  workflowDrafts: workflowDraftsContract,
  workflowGeneration: workflowGenerationContract,
  draftTests: draftTestsContract,
  procurement: procurementContract,
  procurementContext: procurementContextContract,
  resolutionLearning: resolutionLearningContract,
  caseDesk: caseDeskContract,
  operations: operationsContract,
  metrics: metricsContract,
  exceptions: exceptionsContract,
  identity: identityContract,
  settings: settingsContract,
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
  sync: syncContract,
  decisions: decisionsContract,
};
const options = {
  strictStatusCodes: true as const,
  commonResponses: {
    400: apiErrorSchema,
    413: apiErrorSchema,
    415: apiErrorSchema,
    500: apiErrorSchema,
  },
};

export const apiContract: ReturnType<
  typeof c.router<typeof routes, string, typeof options>
> = c.router(routes, options);

export * from './activity.js';

export * from './learning.js';

export * from './desk.js';

export * from './overview.js';

export * from './measurement.js';

export * from './cases.js';

export * from './connections.js';

export { diagnosisSchema } from './diagnosis.js';

export type { Diagnosis } from './diagnosis.js';

export {
  apiErrorSchema,
  dataRegionSchema,
  organizationParamsSchema,
} from './common.js';

export type { ApiError } from './common.js';

export {
  membershipSchema,
  organizationSchema,
  roleSchema,
  tenantContextSchema,
} from './contracts/identity.js';

export { connectorProviderSchema } from './contracts/providers.js';

export type { ConnectorProvider } from './contracts/providers.js';

export {
  caseEventsContract,
  metricEventsContract,
  metricStreamEventSchema,
} from './contracts/events.js';

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

export * from './metrics.js';

export * from './operational-metrics.js';

export * from './records.js';

export * from './orders.js';

export * from './inventory.js';

export * from './fulfillment.js';

export * from './products.js';

export * from './returns.js';

export * from './sync.js';

export * from './decisions.js';
