import { z } from 'zod';

import { caseParams, endpoint, requires } from '../common.js';
import {
  learningCommandSchema,
  learningEventSchema,
  resolutionHistorySchema,
  resolutionRunSchema,
  startResolutionRunSchema,
} from '../learning.js';

export const resolutionLearningContract = {
  list: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/exceptions/{exceptionId}/resolution-runs',
      summary: 'List resolution runs',
      description:
        'People who can manage issues can find up to 50 runs for a case. Pass nextCursor as after to continue; IDs provide stable page ordering. Refresh from the first page to discover newly recorded runs.',
    })
    .meta({
      access: requires('issues.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: caseParams,
        query: z.object({ after: z.string().uuid().optional() }),
      }),
    )
    .output(
      z.object({
        items: z.array(resolutionRunSchema),
        nextCursor: z.string().uuid().nullable(),
      }),
    ),
  start: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations/{organizationId}/exceptions/{exceptionId}/resolution-runs',
      summary: 'Record a resolution selection',
      description:
        'People who can manage issues record a run ID, diagnosis revision, resolution version and reason. Reuse the run ID for automated steps. Exact retries return the original record; conflicting IDs return 409.',
    })
    .meta({
      access: requires('issues.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: caseParams, body: startResolutionRunSchema }))
    .output(resolutionRunSchema),
  append: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations/{organizationId}/exceptions/{exceptionId}/resolution-runs/{runId}/events',
      summary: 'Record a resolution observation',
      description:
        'Append cause assessments, repairs, interventions, edits, outcomes or recurrence links. Use codes and incident evidence references. Model hypotheses remain suspected. Verified outcomes require the incident’s authoritative verification. Exact retries return the original event.',
    })
    .meta({
      access: requires('issues.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: caseParams.extend({ runId: z.string().uuid() }),
        body: learningCommandSchema,
      }),
    )
    .output(learningEventSchema),
  read: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/exceptions/{exceptionId}/resolution-runs/{runId}',
      summary: 'Read resolution learning history',
      description:
        'People who can manage issues can export the original context, ordered operator records, bound steps, execution and all verification attempts. A pending attempt without completion has no known result. Execution acceptance does not establish business success.',
    })
    .meta({
      access: requires('issues.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({ params: caseParams.extend({ runId: z.string().uuid() }) }),
    )
    .output(resolutionHistorySchema),
};
