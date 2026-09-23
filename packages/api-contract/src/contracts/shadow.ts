import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import {
  apiErrorSchema,
  caseParams,
  organizationParamsSchema,
} from '../common.js';
import {
  shadowComparisonSchema,
  shadowEvaluationSchema,
  shadowReportSchema,
  shadowRequestSchema,
  shadowReviewSchema,
  shadowWindowSchema,
} from '../shadow.js';

export const shadowContract = initContract().router(
  {
    latest: {
      method: 'GET',
      path: '/v1/organizations/:organizationId/exceptions/:exceptionId/shadow',
      pathParams: caseParams,
      query: z.object({ workflow: z.string().min(1).max(200) }).strict(),
      responses: { 200: z.object({ item: shadowComparisonSchema.nullable() }) },
      summary: 'Read the latest Shadow evaluation for a case and Playbook',
      description:
        'Returns the retained prediction, operator review and compatible authoritative outcome. Returns null when no evaluation is recorded.',
    },
    evaluate: {
      method: 'POST',
      path: '/v1/organizations/:organizationId/exceptions/:exceptionId/shadow',
      pathParams: caseParams,
      body: shadowRequestSchema,
      responses: { 200: shadowEvaluationSchema },
      summary: 'Evaluate a resolution in Shadow Mode',
      description:
        'Evaluate the current diagnosis and bound Playbook proposal without executing it. Set workflow to the Playbook definition ID. Missing candidates are retained. Reuse the evaluation ID for exact retries.',
    },
    review: {
      method: 'POST',
      path: '/v1/organizations/:organizationId/shadow/:evaluationId/review',
      pathParams: organizationParamsSchema.extend({
        evaluationId: z.string().uuid(),
      }),
      body: shadowReviewSchema,
      responses: { 200: z.object({ recorded: z.literal(true) }) },
      summary: 'Record an operator comparison',
      description:
        'Record the observed operator action, eligibility assessment and optional trust feedback with evidence from this incident. The first review is retained; conflicting retries return 409. Authoritative outcomes are read separately from verification history.',
    },
    report: {
      method: 'GET',
      path: '/v1/organizations/:organizationId/shadow',
      pathParams: organizationParamsSchema,
      query: shadowWindowSchema,
      responses: { 200: shadowReportSchema },
      summary: 'Compare Shadow predictions with observed outcomes',
      description:
        'Owners and admins can compare up to 500 incidents for one Playbook within a time window. The latest evaluation per incident is counted. Rates include denominators and exclude unknown observations. Predictions are conditional simulations, not executed or verified resolutions.',
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
