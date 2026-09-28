import { initContract } from '@ts-rest/core';

import { apiErrorSchema } from './common.js';
import { activityContract } from './contracts/activity.js';
import { appsContract } from './contracts/apps.js';
import { exceptionsContract } from './contracts/cases.js';
import { connectionsContract } from './contracts/connections.js';
import { caseDeskContract } from './contracts/desk.js';
import { identityContract } from './contracts/identity.js';
import { resolutionLearningContract } from './contracts/learning.js';
import { operationsContract } from './contracts/overview.js';
import { playbooksContract } from './contracts/playbooks.js';
import { procurementContract } from './contracts/procurement.js';
import { connectorProvidersContract } from './contracts/providers.js';
import { settingsContract } from './contracts/settings.js';
import { shadowContract } from './contracts/shadow.js';
import { systemContract } from './contracts/system.js';
import { workflowsContract } from './contracts/workflows.js';

const c = initContract();

export const apiContract = c.router(
  {
    shadow: shadowContract,
    activity: activityContract,
    playbooks: playbooksContract,
    workflows: workflowsContract,
    procurement: procurementContract,
    resolutionLearning: resolutionLearningContract,
    caseDesk: caseDeskContract,
    operations: operationsContract,
    exceptions: exceptionsContract,
    identity: identityContract,
    settings: settingsContract,
    connections: connectionsContract,
    apps: appsContract,
    system: systemContract,
    connectorProviders: connectorProvidersContract,
  },
  {
    strictStatusCodes: true,
    commonResponses: {
      400: apiErrorSchema,
      413: apiErrorSchema,
      415: apiErrorSchema,
      500: apiErrorSchema,
    },
  },
);

export * from './activity.js';

export * from './learning.js';

export * from './desk.js';

export * from './overview.js';

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

export { caseEventsContract } from './contracts/events.js';

export * from './playbooks.js';

export * from './shadow.js';

export * from './settings.js';

export * from './apps.js';

export * from './workflows.js';

export * from './code-steps.js';

export * from './procurement.js';

export * from './replenishment.js';
