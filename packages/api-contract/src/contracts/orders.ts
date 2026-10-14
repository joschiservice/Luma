import { z } from 'zod';

import { endpoint, organizationParamsSchema, requires } from '../common.js';
import {
  orderChangePlanQuerySchema,
  orderChangePlansSchema,
  orderDetailSchema,
  orderListQuerySchema,
  orderListSchema,
} from '../orders.js';

export const ordersContract = {
  list: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/orders',
      summary: 'List orders',
      description:
        'Lists current orders from your connected sources. Search matches order numbers, source order IDs, SKU text on order lines and source SKU IDs. Filter by status, payment, source, customer, placed or updated time, or a saved view, and combine conditions from the Orders field catalog with `where`; an unsupported field, operator or value returns 400 naming the condition. Missing or unknown values never match a comparison such as `lineCount eq 0`, and amounts only match in the currency you name. Relative dates such as `today` or the last 7 days use `timeZone`. Warehouse and stock-blocked conditions need access to fulfillment (stock-blocked also to inventory), and customer conditions access to customers; without it they return 403. Outstanding, overdue and needs-you views count the same orders as the order metrics. Sorting puts orders without a value last in either direction; `total` orders by currency, then amount. Pass `group` to receive each group with its exact count, first rows and per-currency totals, and `groupKey` with that group’s `nextCursor` to read more of one group. Conditions, grouping and the newer sorts return 503 while order data is being rebuilt or your access to sources is restricted. Pass `count=exact` to include the total number of matches; otherwise `totalCount` is null. Results use `nextCursor` for the following page; a cursor is only valid with the filters, grouping and sort that produced it, and any other cursor returns 400 with a message to start from the first page.',
    })
    .meta({
      access: requires('orders.read'),
      errors: [400, 401, 403, 404, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        query: orderListQuerySchema,
      }),
    )
    .output(orderListSchema),
  get: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/orders/{orderId}',
      summary: 'Inspect an order',
      description:
        'Returns each source’s current facts for one order, where they differ, fulfillment progress, observed source history, linked issues and workflow runs, and recent Luma activity. Customer and payment details stay in the connected app and are not part of this response.',
    })
    .meta({ access: requires('orders.read'), errors: [401, 404, 503] })
    .input(
      z.object({
        params: organizationParamsSchema.extend({ orderId: z.string().uuid() }),
      }),
    )
    .output(orderDetailSchema),
  changePlan: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/orders/{orderId}/change-plan',
      summary: 'Plan an order change',
      description:
        'Plans a proposed change, or each change source comparison detected: which systems show it, what has shipped (counted once, never added across mirrored systems), whether the change is still safe and the ordered steps. Each step says whether Luma runs it through a governed capability or a person with a role does it. Missing, stale or incomplete fulfilment evidence makes safety unknown, never safe; without access to fulfilment, safety is unknown. Plans change nothing; Luma steps still need a preview, approval and verification. A line that is not on the order returns 422.',
    })
    .meta({
      access: requires('orders.read'),
      errors: [400, 401, 404, 422, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema.extend({ orderId: z.string().uuid() }),
        query: orderChangePlanQuerySchema,
      }),
    )
    .output(orderChangePlansSchema),
};
