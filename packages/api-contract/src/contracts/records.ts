import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import { apiErrorSchema, organizationParamsSchema } from '../common.js';
import {
  recordDetailSchema,
  recordKindSchema,
  recordListSchema,
  recordQuerySchema,
} from '../records.js';

const c = initContract();

export const recordsContract = c.router({
  list: {
    method: 'GET',
    path: '/v1/organizations/:organizationId/records',
    pathParams: organizationParamsSchema,
    query: recordQuerySchema,
    responses: {
      200: recordListSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Search workspace records',
    description:
      'Searches current records in your workspace. Filter by connection to inspect one source. Results are limited to 50 and include source identity, freshness, and coverage. Customer and return coverage is unavailable.',
  },
  get: {
    method: 'GET',
    path: '/v1/organizations/:organizationId/records/:kind/:recordId',
    pathParams: organizationParamsSchema.extend({
      kind: recordKindSchema,
      recordId: z.string().uuid(),
    }),
    responses: {
      200: recordDetailSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Inspect a workspace record',
    description:
      'Returns the current source snapshots and confirmed related records. Each source remains separate so differing or uncertain mappings are visible.',
  },
});
