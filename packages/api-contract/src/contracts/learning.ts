import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import { apiErrorSchema, caseParams } from '../common.js';
import {
  learningCommandSchema,
  learningEventSchema,
  resolutionHistorySchema,
  resolutionRunSchema,
  startResolutionRunSchema,
} from '../learning.js';

const c = initContract();

export const resolutionLearningContract = c.router(
  {
    list: {
      method: 'GET',
      path: '/v1/organizations/:organizationId/exceptions/:exceptionId/resolution-runs',
      pathParams: caseParams,
      query: z.object({ after: z.string().uuid().optional() }),
      responses: {
        200: z.object({
          items: z.array(resolutionRunSchema),
          nextCursor: z.string().uuid().nullable(),
        }),
      },
      summary: 'List resolution runs',
      description:
        'Owners and admins can find up to 50 runs for a case. Pass nextCursor as after to continue; IDs provide stable page ordering. Refresh from the first page to discover newly recorded runs.',
    },
    start: {
      method: 'POST',
      path: '/v1/organizations/:organizationId/exceptions/:exceptionId/resolution-runs',
      pathParams: caseParams,
      body: startResolutionRunSchema,
      responses: { 200: resolutionRunSchema },
      summary: 'Record a resolution selection',
      description:
        'Owners and admins record a run ID, diagnosis revision, resolution version and reason. Reuse the run ID for automated steps. Exact retries return the original record; conflicting IDs return 409.',
    },
    append: {
      method: 'POST',
      path: '/v1/organizations/:organizationId/exceptions/:exceptionId/resolution-runs/:runId/events',
      pathParams: caseParams.extend({ runId: z.string().uuid() }),
      body: learningCommandSchema,
      responses: { 200: learningEventSchema },
      summary: 'Record a resolution observation',
      description:
        'Append cause assessments, repairs, interventions, edits, outcomes or recurrence links. Use codes and incident evidence references. Model hypotheses remain suspected. Verified outcomes require the incident’s authoritative verification. Exact retries return the original event.',
    },
    read: {
      method: 'GET',
      path: '/v1/organizations/:organizationId/exceptions/:exceptionId/resolution-runs/:runId',
      pathParams: caseParams.extend({ runId: z.string().uuid() }),
      responses: { 200: resolutionHistorySchema },
      summary: 'Read resolution learning history',
      description:
        'Owners and admins can export the original context, ordered operator records, bound steps, execution and all verification attempts. A pending attempt without completion has no known result. Execution acceptance does not establish business success.',
    },
  },
  {
    commonResponses: {
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
  },
);
