import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import {
  apiErrorSchema,
  caseParams,
  organizationParamsSchema,
  requires,
} from '../common.js';
import {
  measurementCommandSchema,
  measurementEventSchema,
  measurementHistorySchema,
} from '../measurement.js';
import { operationsOverviewSchema, overviewQuerySchema } from '../overview.js';

const c = initContract();

export const operationsContract = c.router({
  recordMeasurement: {
    method: 'POST',
    metadata: requires('issues.manage'),
    path: '/v1/organizations/:organizationId/exceptions/:exceptionId/measurements',
    pathParams: caseParams,
    body: measurementCommandSchema,
    responses: {
      200: measurementEventSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Record an evidence-backed measurement fact',
    description:
      'People who can manage issues append versioned eligibility, attribution, environment, incorrect-action or measured partner-baseline assessments. Evidence must belong to the incident. Environment is immutable. Expected revision prevents concurrent lost updates; exact retries return the original fact. These facts grant no execution authority.',
  },
  measurementHistory: {
    method: 'GET',
    metadata: requires('issues.read'),
    path: '/v1/organizations/:organizationId/exceptions/:exceptionId/measurements',
    pathParams: caseParams,
    query: z
      .object({ after: z.coerce.number().int().nonnegative().default(0) })
      .strict(),
    responses: {
      200: measurementHistorySchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Read the measurement evidence ledger',
    description:
      'People who can read issues can read up to 100 immutable measurement facts after a revision. Follow nextRevision for more; revision identifies the current head.',
  },
  overview: {
    method: 'GET',
    metadata: requires('issues.read'),
    path: '/v1/organizations/:organizationId/operations/overview',
    pathParams: organizationParamsSchema,
    query: overviewQuerySchema,
    responses: {
      200: operationsOverviewSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Read your operations overview',
    description:
      'Returns current attention and active counts, up to five decisions ordered by severity then oldest request, and verified resolutions in the selected rolling window [start, end). Connection freshness requires observations for every permitted read capability within 24 hours. The measurement summary counts live incidents first detected in the selected window. Exact automation is withheld for unknown eligibility, human attribution or environment; verifiedResolutions retains its completion-time window. Counts describe persisted cases; fresh observations do not establish complete source coverage.',
  },
});
