import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import { apiErrorSchema, organizationParamsSchema } from '../common.js';
import {
  purchaseOrderDetailSchema,
  purchaseOrderInputSchema,
  purchaseOrderSchema,
  supplierInputSchema,
  supplierSchema,
  transitionInputSchema,
} from '../procurement.js';

const c = initContract();
const path = '/v1/organizations/:organizationId/procurement';
const orderParams = organizationParamsSchema.extend({
  purchaseOrderId: z.string().uuid(),
});

export const procurementContract = c.router(
  {
    suppliers: {
      method: 'GET',
      path: `${path}/suppliers`,
      pathParams: organizationParamsSchema,
      responses: {
        200: z.object({
          items: z.array(supplierSchema),
          canManage: z.boolean(),
        }),
      },
      summary: 'List workspace suppliers',
    },
    createSupplier: {
      method: 'POST',
      path: `${path}/suppliers`,
      pathParams: organizationParamsSchema,
      body: supplierInputSchema,
      responses: { 200: supplierSchema },
      summary: 'Create a supplier',
      description:
        'Owners and admins can create suppliers. Retry with the same ID and body after an uncertain response.',
    },
    orders: {
      method: 'GET',
      path: `${path}/purchase-orders`,
      pathParams: organizationParamsSchema,
      responses: {
        200: z.object({
          items: z.array(purchaseOrderSchema),
          canManage: z.boolean(),
        }),
      },
      summary: 'List workspace purchase orders',
    },
    createOrder: {
      method: 'POST',
      path: `${path}/purchase-orders`,
      pathParams: organizationParamsSchema,
      body: purchaseOrderInputSchema,
      responses: { 200: purchaseOrderSchema },
      summary: 'Create a purchase order',
      description:
        'Owners and admins create a draft with immutable lines and provenance. Luma-owned orders support audited lifecycle changes. External ownership requires an external reference and prevents local lifecycle changes. Reuse the ID and body on retry.',
    },
    detail: {
      method: 'GET',
      path: `${path}/purchase-orders/:purchaseOrderId`,
      pathParams: orderParams,
      responses: { 200: purchaseOrderDetailSchema },
      summary: 'Read a purchase order and its lifecycle history',
    },
    transition: {
      method: 'POST',
      path: `${path}/purchase-orders/:purchaseOrderId/transitions`,
      pathParams: orderParams,
      body: transitionInputSchema,
      responses: { 200: purchaseOrderSchema },
      summary: 'Change purchase order status',
      description:
        'Owners and admins move drafts to open or cancelled, and open orders to closed or cancelled. Provide the current revision and a reason. Reuse the command ID and body on retry. Closing records completion; it does not record a warehouse receipt.',
    },
  },
  {
    commonResponses: {
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
  },
);
