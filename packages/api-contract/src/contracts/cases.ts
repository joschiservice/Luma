import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import {
  caseDetailSchema,
  caseEvidencePageSchema,
  caseEvidenceQuerySchema,
  caseListSchema,
  caseQuerySchema,
} from '../cases.js';
import { apiErrorSchema, organizationParamsSchema } from '../common.js';

const c = initContract();

export const exceptionsContract = c.router(
  {
    list: {
      method: 'GET',
      path: '/v1/organizations/:organizationId/exceptions',
      pathParams: organizationParamsSchema,
      query: caseQuerySchema,
      responses: { 200: caseListSchema },
      summary: 'List cases in your organization',
      description:
        'Filter attention, active work or history by class, severity and state. Results sort by severity, oldest attention request or detection, then ID. Use the returned cursor with the same filters. Refresh from the first page as cases change.',
    },
    evidence: {
      method: 'GET',
      path: '/v1/organizations/:organizationId/exceptions/:exceptionId/evidence',
      pathParams: organizationParamsSchema.extend({
        exceptionId: z.string().uuid(),
      }),
      query: caseEvidenceQuerySchema,
      responses: { 200: caseEvidencePageSchema },
      summary: 'Read case evidence references',
      description:
        'Returns persisted observation and verification references ordered by immutable ID, including evidence outside the current diagnosis. Pages default to 25 references and allow at most 100. Reuse cursors only for the same organization, case and page size. As evidence arrives, refresh from the first page and deduplicate by ID. Completeness is unknown unless explicitly recorded for the observation. A null source update time means unknown, regardless of observation freshness.',
    },
    get: {
      method: 'GET',
      path: '/v1/organizations/:organizationId/exceptions/:exceptionId',
      pathParams: organizationParamsSchema.extend({
        exceptionId: z.string().uuid(),
      }),
      responses: { 200: caseDetailSchema },
      summary: 'Read a case investigation',
      description:
        'Returns the current persisted investigation and up to 100 evidence references. Use the evidence endpoint to read further historical references. Recommendations require review; they do not authorize execution. Unavailable cases return not found.',
    },
  },
  {
    commonResponses: {
      401: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
  },
);
