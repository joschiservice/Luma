import { initContract } from '@ts-rest/core';

import { apiErrorSchema } from './common.js';
import { exceptionsContract } from './contracts/cases.js';
import { connectionsContract } from './contracts/connections.js';
import { caseDeskContract } from './contracts/desk.js';
import { identityContract } from './contracts/identity.js';
import { resolutionLearningContract } from './contracts/learning.js';
import { operationsContract } from './contracts/overview.js';
import { connectorProvidersContract } from './contracts/providers.js';
import { systemContract } from './contracts/system.js';

const c = initContract();

export const apiContract = c.router(
  {
    resolutionLearning: resolutionLearningContract,
    caseDesk: caseDeskContract,
    operations: operationsContract,
    exceptions: exceptionsContract,
    identity: identityContract,
    connections: connectionsContract,
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
