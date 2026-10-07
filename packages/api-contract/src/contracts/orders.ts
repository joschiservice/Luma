import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import {
  apiErrorSchema,
  organizationParamsSchema,
  requires,
} from '../common.js';
import {
  orderDetailSchema,
  orderListQuerySchema,
  orderListSchema,
} from '../orders.js';

const c = initContract();

export const ordersContract = c.router({
  list: {
    method: 'GET',
    metadata: requires('orders.read'),
    path: '/v1/organizations/:organizationId/orders',
    pathParams: organizationParamsSchema,
    query: orderListQuerySchema,
    responses: {
      200: orderListSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'List orders',
    description:
      'Lists current orders from your connected sources. Search matches order numbers, source order IDs, SKU text on order lines and source SKU IDs. Filter by status, payment, source, placed or updated time, or a saved view. Outstanding, overdue and needs-you views count the same orders as the order metrics. Pass `count=exact` to include the total number of matches; otherwise `totalCount` is null. Results use `nextCursor` for the following page; a cursor is only valid with the filters and sort that produced it, and any other cursor returns 400 with a message to start from the first page.',
  },
  get: {
    method: 'GET',
    metadata: requires('orders.read'),
    path: '/v1/organizations/:organizationId/orders/:orderId',
    pathParams: organizationParamsSchema.extend({
      orderId: z.string().uuid(),
    }),
    responses: {
      200: orderDetailSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Inspect an order',
    description:
      'Returns each source’s current facts for one order, where they differ, fulfillment progress, observed source history, linked issues and workflow runs, and recent Luma activity. Customer and payment details stay in the connected app and are not part of this response.',
  },
});
