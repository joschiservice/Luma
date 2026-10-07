import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import {
  apiErrorSchema,
  organizationParamsSchema,
  requires,
} from '../common.js';
import {
  fulfillmentDetailSchema,
  fulfillmentListSchema,
  fulfillmentQuerySchema,
} from '../fulfillment.js';

const c = initContract();

export const fulfillmentContract = c.router({
  list: {
    method: 'GET',
    metadata: requires('fulfillment.read'),
    path: '/v1/organizations/:organizationId/fulfillment',
    pathParams: organizationParamsSchema,
    query: fulfillmentQuerySchema,
    responses: {
      200: fulfillmentListSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'List fulfillment work and shipments',
    description:
      'Lists fulfillment orders and shipments as each connected source currently reports them. `attention` returns held, delayed and failed fulfillments; `held` returns open work stopped by a source hold; `delayed` returns open work past its fulfill-by date or without progress for `stalledAfterHours`, and shipments with a reported delivery problem or past their estimated delivery; `open` returns work still expected; `in_transit` returns shipped, undelivered shipments. Search matches order numbers, tracking numbers, location names and source order or fulfillment IDs. Mirrored work in different systems stays separate. Results contain up to `limit` fulfillments (at most 50) with counts per view; `nextCursor` continues the same filters, sort and evaluation time.',
  },
  get: {
    method: 'GET',
    metadata: requires('fulfillment.read'),
    path: '/v1/organizations/:organizationId/fulfillment/:fulfillmentId',
    pathParams: organizationParamsSchema.extend({
      fulfillmentId: z.string().uuid(),
    }),
    responses: {
      200: fulfillmentDetailSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Inspect a fulfillment',
    description:
      'Returns one fulfillment with its lines, order, up to 50 of the order’s other fulfillments, up to 50 observed source states (newest first), linked issues, workflow runs and recent Luma activity. A workflow run’s `progressObservedAt` is the first later read showing the order shipped or its work completed; a method correction or an accepted source request alone does not establish progress.',
  },
});
