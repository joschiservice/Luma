import { z } from 'zod';

import { endpoint, organizationParamsSchema, requires } from '../common.js';
import {
  purchaseOrderContextSchema,
  supplierContextSchema,
} from '../procurement.js';

const path = '/v1/organizations/{organizationId}/procurement';

export const procurementContextContract = {
  order: endpoint
    .route({
      method: 'GET',
      path: `${path}/purchase-orders/{purchaseOrderId}/context`,
      summary: 'Read stock, products and issues around a purchase order',
      description:
        'For each line, the canonical SKU it resolves to, current stock per location and source (never added together), and other draft or open purchase orders for the SKU. Also returns related issues and, for replenishment drafts, the run evidence that created it: stock at the check, the rule’s minimum and target, approval and independent verification. Up to 20 positions per SKU and 50 issues.',
    })
    .meta({ access: requires('procurement.read'), errors: [401, 404, 503] })
    .input(
      z.object({
        params: organizationParamsSchema.extend({
          purchaseOrderId: z.string().uuid(),
        }),
      }),
    )
    .output(purchaseOrderContextSchema),
  supplier: endpoint
    .route({
      method: 'GET',
      path: `${path}/suppliers/{supplierId}/context`,
      summary: 'Read stock for the SKUs a supplier provides',
      description:
        'The SKUs on this supplier’s purchase orders (up to 50, most recent first) with current stock per location and source, units on this supplier’s draft and open orders, and related issues.',
    })
    .meta({ access: requires('procurement.read'), errors: [401, 404, 503] })
    .input(
      z.object({
        params: organizationParamsSchema.extend({
          supplierId: z.string().uuid(),
        }),
      }),
    )
    .output(supplierContextSchema),
};
