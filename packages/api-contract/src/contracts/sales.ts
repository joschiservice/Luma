import { z } from 'zod';

import { endpoint, organizationParamsSchema, requires } from '../common.js';
import { salesEditSchema, salesOrderSchema } from '../sales.js';

const params = organizationParamsSchema.extend({ orderId: z.string().uuid() });

export const salesContract = {
  availability: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/sales/availability',
      summary: 'Check Luma order availability',
    })
    .meta({ access: requires('orders.read'), errors: [401, 403, 404] })
    .input(z.object({ params: organizationParamsSchema }))
    .output(z.object({ enabled: z.boolean() })),
  get: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/sales/orders/{orderId}',
      summary: 'Read a Luma order record',
      description:
        'Returns the editable record and addresses when Luma orders are released for this workspace. Returns null before intake.',
    })
    .meta({ access: requires('sales.manage'), errors: [401, 403, 404, 503] })
    .input(z.object({ params }))
    .output(salesOrderSchema.nullable()),
  accept: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations/{organizationId}/sales/orders/{orderId}/accept',
      summary: 'Accept a Shopify order into Luma',
      description:
        'Copies a current Shopify order into one Luma record. Requires import management. Repeated intake returns the existing record. Does not change source authority.',
    })
    .meta({
      access: requires('sales.manage'),
      errors: [400, 401, 403, 404, 409, 422, 503],
    })
    .input(
      z.object({
        params,
        body: z.object({ connectionId: z.string().uuid() }).strict(),
      }),
    )
    .output(salesOrderSchema),
  edit: endpoint
    .route({
      method: 'PATCH',
      path: '/v1/organizations/{organizationId}/sales/orders/{orderId}',
      summary: 'Edit a Luma order',
      description:
        'Checks the reviewed version and Luma lifecycle and line authority, then atomically saves the record, changed evidence and an audit receipt. Reuse the command ID for an identical retry.',
    })
    .meta({
      access: requires('sales.manage'),
      errors: [400, 401, 403, 404, 409, 422, 503],
    })
    .input(z.object({ params, body: salesEditSchema }))
    .output(salesOrderSchema),
};
