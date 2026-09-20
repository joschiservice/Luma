import { initContract } from '@ts-rest/core';

import { apiErrorSchema, organizationParamsSchema } from '../common.js';
import { operationsOverviewSchema, overviewQuerySchema } from '../overview.js';

const c = initContract();

export const operationsContract = c.router({
  overview: {
    method: 'GET',
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
      'Returns current attention and active counts, up to five decisions ordered by severity then oldest request, and verified resolutions in the selected rolling window [start, end). Connection freshness requires observations for every permitted read capability within 24 hours. Null automation metrics mean eligibility or human-work attribution is unavailable. Counts describe persisted cases; fresh observations do not establish complete source coverage.',
  },
});
