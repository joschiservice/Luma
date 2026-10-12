import { z } from 'zod';

import {
  caseDetailSchema,
  caseEvidencePageSchema,
  caseEvidenceQuerySchema,
  caseListSchema,
  caseOwnerSchema,
  caseQuerySchema,
} from '../cases.js';
import { endpoint, organizationParamsSchema, requires } from '../common.js';

export const exceptionsContract = {
  assignOwner: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations/{organizationId}/exceptions/{exceptionId}/owner',
      summary: 'Assign or clear a case owner',
      description:
        'Changes responsibility with an optimistic revision. Assignment is audited and grants no approval or execution authority.',
    })
    .meta({
      access: requires('decisions.assign'),
      errors: [401, 403, 404, 409, 422, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema.extend({
          exceptionId: z.string().uuid(),
        }),
        body: z
          .object({
            userId: z.string().uuid().nullable(),
            revision: z.number().int().nonnegative(),
          })
          .strict(),
      }),
    )
    .output(caseOwnerSchema),
  list: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/exceptions',
      summary: 'List cases in your organization',
      description:
        'Filter attention, active work or history by class, severity and state. Results sort by severity, oldest attention request or detection, then ID. Use the returned cursor with the same filters. Refresh from the first page as cases change.',
    })
    .meta({ access: requires('issues.read'), errors: [401, 404, 503] })
    .input(
      z.object({ params: organizationParamsSchema, query: caseQuerySchema }),
    )
    .output(caseListSchema),
  evidence: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/exceptions/{exceptionId}/evidence',
      summary: 'Read case evidence references',
      description:
        'Returns persisted observation and verification references ordered by immutable ID, including evidence outside the current diagnosis. Pages default to 25 references and allow at most 100. Reuse cursors only for the same organization, case and page size. As evidence arrives, refresh from the first page and deduplicate by ID. Completeness is unknown unless explicitly recorded for the observation. A null source update time means unknown, regardless of observation freshness.',
    })
    .meta({ access: requires('issues.read'), errors: [401, 404, 503] })
    .input(
      z.object({
        params: organizationParamsSchema.extend({
          exceptionId: z.string().uuid(),
        }),
        query: caseEvidenceQuerySchema,
      }),
    )
    .output(caseEvidencePageSchema),
  get: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/exceptions/{exceptionId}',
      summary: 'Read a case investigation',
      description:
        'Returns the current persisted investigation and up to 100 evidence references. Use the evidence endpoint to read further historical references. Recommendations require review; they do not authorize execution. Unavailable cases return not found.',
    })
    .meta({ access: requires('issues.read'), errors: [401, 404, 503] })
    .input(
      z.object({
        params: organizationParamsSchema.extend({
          exceptionId: z.string().uuid(),
        }),
      }),
    )
    .output(caseDetailSchema),
};
