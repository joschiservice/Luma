import { z } from 'zod';

import { changePageSchema, changeQuerySchema } from '../changes.js';
import { endpoint, organizationParamsSchema, requires } from '../common.js';

export const changesContract = {
  list: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/changes',
      summary: 'Follow changed records',
      description:
        'Lists which orders, fulfillment, returns, stock positions, products, customers, return cases and issues changed, in the order their changes were committed. Each change names the record type, ID and whether it was `upserted` or `deleted`, never its content: read the record through its own route. Several changes to one record in one transaction appear once, and a record can appear again without a visible difference, so treat each change as a reason to reread. A reread that returns 404 means the record is gone. To keep a copy current, request without `after` to get the current position, read every record through the list routes, then follow from that position with `after` set to each response’s `cursor`. A change appears once every transaction that started before it has finished, so a very long transaction delays the feed but never skips a change. Changes are kept for 30 days: a cursor older than that returns 410, and you need to read every record again. Only record types you can read are returned; naming one you can’t returns 403. Workflows and activity are not included.',
    })
    .meta({
      publicApi: true,
      access: requires([
        'orders.read',
        'fulfillment.read',
        'returns.read',
        'inventory.read',
        'products.read',
        'customers.read',
        'issues.read',
      ]),
      errors: [400, 401, 403, 404, 410, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        query: changeQuerySchema,
      }),
    )
    .output(changePageSchema),
};
