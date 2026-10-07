import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import {
  apiErrorSchema,
  organizationParamsSchema,
  requires,
} from '../common.js';
import {
  returnDetailSchema,
  returnListSchema,
  returnQuerySchema,
} from '../returns.js';

const c = initContract();

export const returnsContract = c.router({
  list: {
    method: 'GET',
    metadata: requires('returns.read'),
    path: '/v1/organizations/:organizationId/returns',
    pathParams: organizationParamsSchema,
    query: returnQuerySchema,
    responses: {
      200: returnListSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Browse returns and refunds',
    description:
      'List returns imported from connected stores, and refunds that no return settles, with their stage and refund state. `action` returns need a person: a request to review, units to refund, a failed refund payment or a return to close. `waiting` returns wait for items or a processing refund payment; `done` returns are closed, declined, cancelled or refunded. `refund.refunded` sums successful refund payments only; pending and failed payments are reported separately and never count as money returned. `sources` lists each commerce connection and whether it shares returns with Luma. Search matches the return name, order number, return reason and source IDs. Results contain up to `limit` records (at most 50) with counts per view and stage; nextCursor continues the same filters and sorting.',
  },
  get: {
    method: 'GET',
    metadata: requires('returns.read'),
    path: '/v1/organizations/:organizationId/returns/:returnId',
    pathParams: organizationParamsSchema.extend({
      returnId: z.string().uuid(),
    }),
    responses: {
      200: returnDetailSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Inspect a return',
    description:
      'Read one return with its items, reasons, receipt and refund quantities, refunds with every payment attempt, the order it belongs to, other returns of that order and up to 50 observed snapshots. The ID of a refund that settles a return resolves to that return. Returns are read-only: approve, receive and refund them in the source store.',
  },
});
