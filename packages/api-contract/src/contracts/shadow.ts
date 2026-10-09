import { z } from 'zod';

import {
  caseParams,
  endpoint,
  organizationParamsSchema,
  requires,
} from '../common.js';
import {
  shadowComparisonSchema,
  shadowEvaluationSchema,
  shadowReportSchema,
  shadowRequestSchema,
  shadowReviewSchema,
  shadowWindowSchema,
} from '../shadow.js';

export const shadowContract = {
  latest: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/exceptions/{exceptionId}/shadow',
      summary: 'Read the latest Shadow evaluation for a case and Workflow',
      description:
        'Returns the retained prediction, operator review and compatible authoritative outcome. Returns null when no evaluation is recorded.',
    })
    .meta({
      access: requires('playbooks.activate'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: caseParams,
        query: z.object({ workflow: z.string().min(1).max(200) }).strict(),
      }),
    )
    .output(z.object({ item: shadowComparisonSchema.nullable() })),
  evaluate: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations/{organizationId}/exceptions/{exceptionId}/shadow',
      summary: 'Evaluate a resolution in Shadow Mode',
      description:
        'Evaluate the current diagnosis and bound Workflow proposal without executing it. Set workflow to the Workflow definition ID. Missing candidates are retained. Reuse the evaluation ID for exact retries.',
    })
    .meta({
      access: requires('playbooks.activate'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: caseParams, body: shadowRequestSchema }))
    .output(shadowEvaluationSchema),
  review: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations/{organizationId}/shadow/{evaluationId}/review',
      summary: 'Record an operator comparison',
      description:
        'Record the observed operator action, eligibility assessment and optional trust feedback with evidence from this incident. The first review is retained; conflicting retries return 409. Authoritative outcomes are read separately from verification history.',
    })
    .meta({
      access: requires('playbooks.activate'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema.extend({
          evaluationId: z.string().uuid(),
        }),
        body: shadowReviewSchema,
      }),
    )
    .output(z.object({ recorded: z.literal(true) })),
  report: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/shadow',
      summary: 'Compare Shadow predictions with observed outcomes',
      description:
        'People who can activate playbooks can compare up to 500 incidents for one Workflow within a time window. The latest evaluation per incident is counted. Rates include denominators and exclude unknown observations. Predictions are conditional simulations, not executed or verified resolutions.',
    })
    .meta({
      access: requires('playbooks.activate'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({ params: organizationParamsSchema, query: shadowWindowSchema }),
    )
    .output(shadowReportSchema),
};
