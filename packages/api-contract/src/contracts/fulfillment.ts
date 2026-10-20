import { z } from 'zod';

import { endpoint, organizationParamsSchema, requires } from '../common.js';
import {
  fulfillmentDetailSchema,
  fulfillmentListSchema,
  fulfillmentQuerySchema,
} from '../fulfillment.js';

export const fulfillmentContract = {
  list: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/fulfillment',
      summary: 'List fulfillment work and shipments',
      description:
        'Lists fulfillment orders and shipments as each connected source currently reports them. `attention` returns held, delayed and failed fulfillments; `held` returns open work stopped by a source hold; `delayed` returns open work past its fulfill-by date or without progress for `stalledAfterHours`, and shipments with a reported delivery problem or past their estimated delivery; `open` returns work still expected; `in_transit` returns shipped, undelivered shipments. Search matches order numbers, tracking numbers, location names and source order or fulfillment IDs. Mirrored work in different systems stays separate. Conditions (`where`) and grouping (`group`) use the Fulfillment catalog fields and also narrow the per-view counts; holds a source does not report are unknown and match no comparison. Results contain up to `limit` fulfillments (at most 50) with counts per view; `nextCursor` continues the same filters, conditions, grouping, sort and evaluation time.',
    })
    .meta({
      publicApi: true,
      access: requires('fulfillment.read'),
      errors: [400, 401, 403, 404, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        query: fulfillmentQuerySchema,
      }),
    )
    .output(fulfillmentListSchema),
  get: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/fulfillment/{fulfillmentId}',
      summary: 'Inspect a fulfillment',
      description:
        'Returns one fulfillment with its lines, order, up to 50 of the order’s other fulfillments, up to 50 observed source states (newest first), linked issues, workflow runs and recent Luma activity. A workflow run’s `progressObservedAt` is the first later read showing the order shipped or its work completed; a method correction or an accepted source request alone does not establish progress.',
    })
    .meta({
      publicApi: true,
      access: requires('fulfillment.read'),
      errors: [401, 403, 404, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema.extend({
          fulfillmentId: z.string().uuid(),
        }),
      }),
    )
    .output(fulfillmentDetailSchema),
};
