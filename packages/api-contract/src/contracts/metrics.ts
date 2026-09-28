import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import { apiErrorSchema, organizationParamsSchema } from '../common.js';
import {
  metricDefinitionSchema,
  metricRequestSchema,
  metricResponseSchema,
} from '../metrics.js';

const c = initContract();

export const metricsContract = c.router({
  definitions: {
    method: 'GET',
    path: '/v1/organizations/:organizationId/metrics',
    pathParams: organizationParamsSchema,
    responses: {
      200: z.array(metricDefinitionSchema),
      401: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Read shared operational metric definitions',
    description:
      'Lists versioned counting rules, supported filters, permissions and drill-down semantics for canonical order metrics.',
  },
  query: {
    method: 'POST',
    path: '/v1/organizations/:organizationId/metrics/query',
    pathParams: organizationParamsSchema,
    body: metricRequestSchema,
    responses: {
      200: metricResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Read order totals and their matching records',
    description:
      'Returns open, overdue and attention counts with bounded cohorts from one consistent read snapshot. Null totals mean incomplete source coverage; observedCount counts only known matching orders. Reuse snapshot and asOf when paging. A 409 requires refreshing from offset zero. Windows filter accepted source update times using [updatedFrom, updatedBefore) UTC instants. Requests accept only registered fields, never executable code.',
  },
});
