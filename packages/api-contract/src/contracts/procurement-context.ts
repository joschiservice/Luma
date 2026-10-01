import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import { apiErrorSchema, organizationParamsSchema } from '../common.js';
import {
  purchaseOrderContextSchema,
  supplierContextSchema,
} from '../procurement.js';

const c = initContract();
const path = '/v1/organizations/:organizationId/procurement';

export const procurementContextContract = c.router(
  {
    order: {
      method: 'GET',
      path: `${path}/purchase-orders/:purchaseOrderId/context`,
      pathParams: organizationParamsSchema.extend({
        purchaseOrderId: z.string().uuid(),
      }),
      responses: { 200: purchaseOrderContextSchema },
      summary: 'Read stock, products and issues around a purchase order',
      description:
        'For each line, the canonical SKU it resolves to, current stock per location and source (never added together), and other draft or open purchase orders for the SKU. Also returns related issues and, for replenishment drafts, the run evidence that created it: stock at the check, the rule’s minimum and target, approval and independent verification. Up to 20 positions per SKU and 50 issues.',
    },
    supplier: {
      method: 'GET',
      path: `${path}/suppliers/:supplierId/context`,
      pathParams: organizationParamsSchema.extend({
        supplierId: z.string().uuid(),
      }),
      responses: { 200: supplierContextSchema },
      summary: 'Read stock for the SKUs a supplier provides',
      description:
        'The SKUs on this supplier’s purchase orders (up to 50, most recent first) with current stock per location and source, units on this supplier’s draft and open orders, and related issues.',
    },
  },
  {
    commonResponses: {
      401: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
  },
);
