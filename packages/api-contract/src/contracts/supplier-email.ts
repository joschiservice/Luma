import { z } from 'zod';

import { endpoint, organizationParamsSchema, requires } from '../common.js';
import { supplierSchema } from '../procurement.js';
import {
  supplierContactInputSchema,
  supplierEmailDraftSchema,
  supplierEmailInputSchema,
  supplierEmailStatusSchema,
  supplierFollowUpInputSchema,
} from '../supplier-email.js';

const params = organizationParamsSchema.extend({
  purchaseOrderId: z.string().uuid(),
});
const path =
  '/v1/organizations/{organizationId}/procurement/purchase-orders/{purchaseOrderId}/email';

export const supplierEmailContract = {
  document: endpoint
    .route({
      method: 'GET',
      path: `${path}/outgoing/{outboundId}/document`,
      summary: 'Read the exact order PDF before requesting approval',
    })
    .meta({
      access: requires('procurement.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({ params: params.extend({ outboundId: z.string().uuid() }) }),
    )
    .output(
      z.object({
        filename: z.string(),
        mimeType: z.string(),
        base64: z.string().max(14_000_000),
      }),
    ),
  contact: endpoint
    .route({
      method: 'PATCH',
      path: '/v1/organizations/{organizationId}/procurement/suppliers/{supplierId}/contact',
      summary: 'Update a supplier email address and correspondence language',
    })
    .meta({
      access: requires('procurement.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema.extend({
          supplierId: z.string().uuid(),
        }),
        body: supplierContactInputSchema,
      }),
    )
    .output(supplierSchema),
  status: endpoint
    .route({
      method: 'GET',
      path,
      summary: 'Read supplier email drafts and available Operations Inboxes',
    })
    .meta({
      access: requires('procurement.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params }))
    .output(supplierEmailStatusSchema),
  submission: endpoint
    .route({
      method: 'POST',
      path: `${path}/submission`,
      summary: 'Draft a purchase-order email with a PDF',
      description:
        'Requires procurement.manage and messages.send. Creates a reviewable Operations Inbox draft; requesting approval and sending use the existing inbox. Mail acceptance does not establish supplier confirmation.',
    })
    .meta({
      access: requires('procurement.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params, body: supplierEmailInputSchema }))
    .output(supplierEmailDraftSchema),
  followUp: endpoint
    .route({
      method: 'POST',
      path: `${path}/follow-up`,
      summary: 'Draft a supplier follow-up from an overdue commitment',
      description:
        'Requires procurement.manage and messages.send. A verified send records the follow-up and its next check time. Drafting alone does not move the deadline.',
    })
    .meta({
      access: requires('procurement.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params, body: supplierFollowUpInputSchema }))
    .output(supplierEmailDraftSchema),
};
