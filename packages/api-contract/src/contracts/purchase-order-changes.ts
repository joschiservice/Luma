import { z } from 'zod';

import { endpoint, organizationParamsSchema, requires } from '../common.js';
import {
  purchaseOrderChangeInputSchema,
  purchaseOrderChangeSchema,
  purchaseOrderRevisionSchema,
} from '../purchase-order-changes.js';

const path = '/v1/organizations/{organizationId}/procurement';
const order = organizationParamsSchema.extend({
  purchaseOrderId: z.string().uuid(),
});
const change = organizationParamsSchema.extend({ changeId: z.string().uuid() });
const manage = {
  access: requires('procurement.manage'),
  errors: [401, 403, 404, 409, 503] as const,
};

export const procurementChangesContract = {
  list: endpoint
    .route({
      method: 'GET',
      path: `${path}/purchase-orders/{purchaseOrderId}/changes`,
      summary: 'Read approved order changes and previous revisions',
      description:
        'Reports which source changes are supported. JTL-Wawi cancellation is unavailable; completion is never treated as cancellation.',
    })
    .meta({
      access: requires('procurement.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: order }))
    .output(
      z.object({
        enabled: z.boolean(),
        canManage: z.boolean(),
        canRevise: z.boolean(),
        cancelAvailable: z.literal(false),
        cancelReasonCode: z.enum(['received', 'unsupported']),
        cancelReason: z.string(),
        changes: z.array(purchaseOrderChangeSchema),
        revisions: z.array(purchaseOrderRevisionSchema),
      }),
    ),
  propose: endpoint
    .route({
      method: 'POST',
      path: `${path}/purchase-orders/{purchaseOrderId}/changes`,
      summary: 'Request approval for one purchase-order revision',
      description:
        'Proposes one quantity/date change, added line or removed line against the current order revision and a fresh purchasing-system read. Give a reason, including when commitments are affected. Cancellation is refused if goods were received and is unavailable in the JTL-Wawi API. Reuse the same ID and body after an uncertain response.',
    })
    .meta(manage)
    .input(z.object({ params: order, body: purchaseOrderChangeInputSchema }))
    .output(purchaseOrderChangeSchema),
  decide: endpoint
    .route({
      method: 'POST',
      path: `${path}/order-changes/{changeId}/decision`,
      summary: 'Approve or reject a purchase-order revision',
    })
    .meta(manage)
    .input(
      z.object({
        params: change,
        body: z.object({ outcome: z.enum(['approved', 'rejected']) }).strict(),
      }),
    )
    .output(purchaseOrderChangeSchema),
  send: endpoint
    .route({
      method: 'POST',
      path: `${path}/order-changes/{changeId}/send`,
      summary: 'Send an approved order revision',
      description:
        'Dispatches approved work as its requester. Repeated calls return the recorded attempt; uncertain writes are never repeated.',
    })
    .meta(manage)
    .input(z.object({ params: change, body: z.object({}).strict() }))
    .output(purchaseOrderChangeSchema),
  check: endpoint
    .route({
      method: 'POST',
      path: `${path}/order-changes/{changeId}/check`,
      summary: 'Verify an uncertain order revision',
      description:
        'Reads the purchasing system only. A verified read appends the new local order revision and keeps the previous revision.',
    })
    .meta(manage)
    .input(z.object({ params: change, body: z.object({}).strict() }))
    .output(purchaseOrderChangeSchema),
};
