import { z } from 'zod';

import {
  caseParams,
  endpoint,
  organizationParamsSchema,
  requires,
} from '../common.js';
import {
  measurementCommandSchema,
  measurementEventSchema,
  measurementHistorySchema,
} from '../measurement.js';
import { operationsOverviewSchema, overviewQuerySchema } from '../overview.js';

export const operationsContract = {
  recordMeasurement: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations/{organizationId}/exceptions/{exceptionId}/measurements',
      summary: 'Record an evidence-backed measurement fact',
      description:
        'People who can manage issues append versioned eligibility, attribution, environment, incorrect-action or measured partner-baseline assessments. Evidence must belong to the incident. Environment is immutable. Expected revision prevents concurrent lost updates; exact retries return the original fact. These facts grant no execution authority.',
    })
    .meta({
      access: requires('issues.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: caseParams, body: measurementCommandSchema }))
    .output(measurementEventSchema),
  measurementHistory: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/exceptions/{exceptionId}/measurements',
      summary: 'Read the measurement evidence ledger',
      description:
        'People who can read issues can read up to 100 immutable measurement facts after a revision. Follow nextRevision for more; revision identifies the current head.',
    })
    .meta({ access: requires('issues.read'), errors: [401, 403, 404, 503] })
    .input(
      z.object({
        params: caseParams,
        query: z
          .object({ after: z.coerce.number().int().nonnegative().default(0) })
          .strict(),
      }),
    )
    .output(measurementHistorySchema),
  overview: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/operations/overview',
      summary: 'Read your operations overview',
      description:
        'Returns current attention and active counts, up to five decisions ordered by severity then oldest request, and verified resolutions in the selected rolling window [start, end). Connection freshness requires observations for every permitted read capability within 24 hours. The measurement summary counts live incidents first detected in the selected window. Exact automation is withheld for unknown eligibility, human attribution or environment; verifiedResolutions retains its completion-time window. Counts describe persisted cases; fresh observations do not establish complete source coverage.',
    })
    .meta({ access: requires('issues.read'), errors: [401, 404, 503] })
    .input(
      z.object({
        params: organizationParamsSchema,
        query: overviewQuerySchema,
      }),
    )
    .output(operationsOverviewSchema),
};
