import { z } from 'zod';

import { endpoint, organizationParamsSchema, requires } from '../common.js';
import {
  returnDetailSchema,
  returnListSchema,
  returnQuerySchema,
} from '../returns.js';

export const returnsContract = {
  list: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/returns',
      summary: 'Browse returns and refunds',
      description:
        'List returns imported from connected stores, and refunds that no return settles, with their stage and refund state. `action` returns need a person: a request to review, units to refund, a failed refund payment or a return to close. `waiting` returns wait for items or a processing refund payment; `done` returns are closed, declined, cancelled or refunded. `refund.refunded` sums successful refund payments only; pending and failed payments are reported separately and never count as money returned. `sources` lists each commerce connection and whether it shares returns with Luma. Search matches the return name, order number, return reason and source IDs. Results contain up to `limit` records (at most 50) with counts per view and stage; nextCursor continues the same filters and sorting.',
    })
    .meta({ access: requires('returns.read'), errors: [400, 401, 404, 503] })
    .input(
      z.object({ params: organizationParamsSchema, query: returnQuerySchema }),
    )
    .output(returnListSchema),
  get: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/returns/{returnId}',
      summary: 'Inspect a return',
      description:
        'Read one return with its items, reasons, receipt and refund quantities, refunds with every payment attempt, the order it belongs to, other returns of that order and up to 50 observed snapshots. The ID of a refund that settles a return resolves to that return. Store returns are read-only here; work them in a return case, and approve, receive and refund them in the source store.',
    })
    .meta({ access: requires('returns.read'), errors: [401, 404, 503] })
    .input(
      z.object({
        params: organizationParamsSchema.extend({
          returnId: z.string().uuid(),
        }),
      }),
    )
    .output(returnDetailSchema),
};
