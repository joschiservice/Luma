import { z } from 'zod';

import { endpoint, organizationParamsSchema, requires } from '../common.js';
import {
  commitmentInputSchema,
  commitmentSchema,
  communicationSchema,
  extractionSchema,
  followUpInputSchema,
  followUpSchema,
  messageInputSchema,
  orderSummarySchema,
  purchaseOrderDetailSchema,
  purchaseOrderInputSchema,
  purchaseOrderListQuerySchema,
  purchaseOrderListSchema,
  purchaseOrderRecordSchema,
  purchaseOrderSchema,
  purchasingConnectionSchema,
  purchasingSupplierSchema,
  receiptInputSchema,
  reviewInputSchema,
  submissionDecisionSchema,
  submissionInputSchema,
  submissionViewSchema,
  supplierInputSchema,
  supplierLinkInputSchema,
  supplierListQuerySchema,
  supplierListSchema,
  supplierRecordSchema,
  supplierSchema,
  transitionInputSchema,
} from '../procurement.js';
import {
  supplierProductTermsSchema,
  supplierTermsInputSchema,
} from '../supplier-terms.js';
import { incomingStockContract } from './incoming-stock.js';
import { purchasingContract } from './purchasing.js';

const path = '/v1/organizations/{organizationId}/procurement';
const orderParams = organizationParamsSchema.extend({
  purchaseOrderId: z.string().uuid(),
});
const supplierParams = organizationParamsSchema.extend({
  supplierId: z.string().uuid(),
});
const submissionParams = organizationParamsSchema.extend({
  submissionId: z.string().uuid(),
});
const messageParams = organizationParamsSchema.extend({
  communicationId: z.string().uuid(),
});
const commitmentParams = organizationParamsSchema.extend({
  commitmentId: z.string().uuid(),
});
const connectionParams = organizationParamsSchema.extend({
  connectionId: z.string().uuid(),
});

export const procurementContract = {
  ...incomingStockContract,
  supplierTerms: endpoint
    .route({
      method: 'GET',
      path: `${path}/supplier-terms`,
      summary: 'Read supplier purchasing terms and their sources',
    })
    .meta({
      access: requires('procurement.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        query: z.object({
          supplierId: z.string().uuid().optional(),
          skuId: z.string().uuid().optional(),
        }),
      }),
    )
    .output(
      z.object({
        items: z.array(supplierProductTermsSchema),
        canManage: z.boolean(),
        enabled: z.boolean(),
      }),
    ),
  saveSupplierTerms: endpoint
    .route({
      method: 'POST',
      path: `${path}/supplier-terms`,
      summary: 'Record a purchasing term override',
      description:
        'Records a separate override with its reason. Preserves provider observations and price history. Provide the current revision and reuse the ID and body after an uncertain response.',
    })
    .meta({
      access: requires('procurement.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: supplierTermsInputSchema,
      }),
    )
    .output(supplierProductTermsSchema),
  ...purchasingContract,
  suppliers: endpoint
    .route({
      method: 'GET',
      path: `${path}/suppliers`,
      summary: 'List workspace suppliers',
      description:
        'Returns one page of suppliers with their purchase-order count. `nextCursor` continues the same search and sort.',
    })
    .meta({
      access: requires('procurement.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        query: supplierListQuerySchema,
      }),
    )
    .output(supplierListSchema),
  createSupplier: endpoint
    .route({
      method: 'POST',
      path: `${path}/suppliers`,
      summary: 'Create a supplier',
      description:
        'Requires `procurement.manage`. Retry with the same ID and body after an uncertain response.',
    })
    .meta({
      access: requires('procurement.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({ params: organizationParamsSchema, body: supplierInputSchema }),
    )
    .output(supplierSchema),
  orders: endpoint
    .route({
      method: 'GET',
      path: `${path}/purchase-orders`,
      summary: 'List workspace purchase orders',
      description:
        'Returns one page of purchase orders with their stage, expected date and attention, filtered and sorted on the server. Stage and attention depend on the evaluation time; later pages keep the time of the first page. `nextCursor` continues the same filters and sort; a cursor from other filters returns 400.',
    })
    .meta({
      access: requires('procurement.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        query: purchaseOrderListQuerySchema,
      }),
    )
    .output(purchaseOrderListSchema),
  createOrder: endpoint
    .route({
      method: 'POST',
      path: `${path}/purchase-orders`,
      summary: 'Create a purchase order',
      description:
        'Requires `procurement.manage`. Creates a draft with immutable lines and provenance. Luma-owned orders support audited lifecycle changes. External ownership requires an external reference and prevents local lifecycle changes. Reuse the ID and body on retry.',
    })
    .meta({
      access: requires('procurement.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: purchaseOrderInputSchema,
      }),
    )
    .output(purchaseOrderSchema),
  detail: endpoint
    .route({
      method: 'GET',
      path: `${path}/purchase-orders/{purchaseOrderId}`,
      summary: 'Read a purchase order and its lifecycle history',
    })
    .meta({
      access: requires('procurement.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: orderParams }))
    .output(purchaseOrderDetailSchema),
  supplier: endpoint
    .route({
      method: 'GET',
      path: `${path}/suppliers/{supplierId}`,
      summary: 'Read a supplier record',
      description:
        'Returns the supplier, its purchasing-system link, every purchase order with its stage and progress, and recent supplier messages. Stages come from recorded evidence: confirmation and receipt are read from the purchasing system or recorded from supplier messages; receipt only from the purchasing system.',
    })
    .meta({
      access: requires('procurement.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: supplierParams }))
    .output(supplierRecordSchema),
  linkSupplier: endpoint
    .route({
      method: 'POST',
      path: `${path}/suppliers/{supplierId}/link`,
      summary: 'Link a supplier to its purchasing-system record',
      description:
        'Requires `procurement.manage`. Links the supplier to a supplier in a connected purchasing system, or removes the link, and sets how many hours the supplier has to confirm a sent order. Provide the current revision. The purchasing-system supplier is read again before it is linked.',
    })
    .meta({
      access: requires('procurement.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: supplierParams, body: supplierLinkInputSchema }))
    .output(supplierSchema),
  purchasingConnections: endpoint
    .route({
      method: 'GET',
      path: `${path}/purchasing-connections`,
      summary: 'List purchasing-system connections',
      description:
        'Connections that requested supplier or purchase-order access, with what they are currently allowed to do.',
    })
    .meta({
      access: requires('procurement.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: organizationParamsSchema }))
    .output(z.array(purchasingConnectionSchema)),
  purchasingSuppliers: endpoint
    .route({
      method: 'GET',
      path: `${path}/purchasing-connections/{connectionId}/suppliers`,
      summary: 'List suppliers in a purchasing system',
      description:
        'Requires `procurement.manage`. Reads up to 100 suppliers per page from the connection, for linking. Nothing is stored.',
    })
    .meta({
      access: requires('procurement.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: connectionParams,
        query: z.object({ cursor: z.string().max(4096).optional() }),
      }),
    )
    .output(
      z.object({
        items: z.array(purchasingSupplierSchema),
        nextCursor: z.string().nullable(),
      }),
    ),
  progress: endpoint
    .route({
      method: 'GET',
      path: `${path}/purchase-orders/progress`,
      summary: 'Summarize purchase-order progress',
      description:
        'One stage per order (draft, sending, awaiting confirmation, confirmed, changed, partially received, received, closed or cancelled), with the earliest expected date of outstanding units, how many items need attention and who acts next.',
    })
    .meta({
      access: requires('procurement.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: organizationParamsSchema }))
    .output(z.object({ items: z.array(orderSummarySchema) })),
  record: endpoint
    .route({
      method: 'GET',
      path: `${path}/purchase-orders/{purchaseOrderId}/record`,
      summary: 'Read a purchase order record with its supplier lifecycle',
      description:
        'Returns the order, lifecycle history, its submission to a purchasing system, supplier messages and extraction attempts, every commitment with its source, purchasing-system reads, follow-up responses and derived progress. A draft, a sent order, a supplier confirmation and a booked goods receipt are separate milestones; only the purchasing system establishes receipt.',
    })
    .meta({
      access: requires('procurement.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: orderParams }))
    .output(purchaseOrderRecordSchema),
  refresh: endpoint
    .route({
      method: 'POST',
      path: `${path}/purchase-orders/{purchaseOrderId}/refresh`,
      summary: 'Read the purchasing system now',
      description:
        'Reads the order in its purchasing system and records any new confirmation or receipt. Requires `procurement.read`.',
    })
    .meta({
      access: requires('procurement.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: orderParams, body: z.object({}).strict() }))
    .output(purchaseOrderRecordSchema),
  requestSubmission: endpoint
    .route({
      method: 'POST',
      path: `${path}/purchase-orders/{purchaseOrderId}/submissions`,
      summary: 'Request approval to send an order to the supplier',
      description:
        'Requires `procurement.manage`. Asks for approval to place this draft or open order in the supplier’s linked purchasing system, with a requested delivery date. Someone else with `procurement.manage` and `decisions.respond` must approve. Every line’s SKU must be linked to a purchasing-system item. After approval Luma places the order once and verifies it with an independent read; the purchasing system sends it to the supplier. Reuse the ID and body after an uncertain response. Requests expire after 24 hours.',
    })
    .meta({
      access: requires('procurement.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: orderParams, body: submissionInputSchema }))
    .output(submissionViewSchema),
  decideSubmission: endpoint
    .route({
      method: 'POST',
      path: `${path}/submissions/{submissionId}/decision`,
      summary: 'Approve or reject sending an order',
      description:
        'Requires `procurement.manage` and `decisions.respond`, plus any app permission the purchasing capability declares. An authorized person approves or rejects the exact submission under the workspace independent approval setting. Approval dispatches it as the requester after their membership, the order and the supplier link are checked again.',
    })
    .meta({
      access: requires('procurement.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({ params: submissionParams, body: submissionDecisionSchema }),
    )
    .output(submissionViewSchema),
  sendSubmission: endpoint
    .route({
      method: 'POST',
      path: `${path}/submissions/{submissionId}/send`,
      summary: 'Send an approved order now',
      description:
        'The requester dispatches an approved submission that has not been sent. Repeated calls return the recorded attempt.',
    })
    .meta({
      access: requires('procurement.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: submissionParams, body: z.object({}).strict() }))
    .output(submissionViewSchema),
  checkSubmission: endpoint
    .route({
      method: 'POST',
      path: `${path}/submissions/{submissionId}/check`,
      summary: 'Check an uncertain submission',
      description:
        'Reads the purchasing system to settle whether an uncertain submission created the order. It never sends the order again.',
    })
    .meta({
      access: requires('procurement.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: submissionParams, body: z.object({}).strict() }))
    .output(submissionViewSchema),
  recordMessage: endpoint
    .route({
      method: 'POST',
      path: `${path}/purchase-orders/{purchaseOrderId}/messages`,
      summary: 'Record a supplier message',
      description:
        'Requires `procurement.manage`. Records a supplier message for this order. When an EU model route is configured, Luma lists the commitments it states, each with the exact words it came from; changes, uncertain readings and conditions wait for review. The same message, by message ID or content, is recorded once. Text is removed after the retention period.',
    })
    .meta({
      access: requires('procurement.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: orderParams, body: messageInputSchema }))
    .output(
      z.object({
        communicationId: z.string().uuid(),
        duplicate: z.boolean(),
      }),
    ),
  readMessage: endpoint
    .route({
      method: 'POST',
      path: `${path}/messages/{communicationId}/read`,
      summary: 'Read a supplier message again',
      description:
        'Retries reading a message whose earlier attempts were unavailable or failed.',
    })
    .meta({
      access: requires('procurement.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: messageParams, body: z.object({}).strict() }))
    .output(extractionSchema),
  removeMessageText: endpoint
    .route({
      method: 'POST',
      path: `${path}/messages/{communicationId}/remove-text`,
      summary: 'Remove a supplier message’s text',
      description:
        'Requires `procurement.manage`. Removes the subject and text now. The sender, time, content digest and recorded commitments remain; quotes can no longer be shown.',
    })
    .meta({
      access: requires('procurement.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: messageParams, body: z.object({}).strict() }))
    .output(communicationSchema),
  recordCommitment: endpoint
    .route({
      method: 'POST',
      path: `${path}/purchase-orders/{purchaseOrderId}/commitments`,
      summary: 'Record or correct a supplier commitment',
      description:
        'Requires `procurement.manage`. Records a confirmed quantity, promised date, shipment or condition by selecting the words in a supplier message, or corrects an earlier commitment with a reason. Corrections add a commitment; nothing is overwritten. Receipt cannot be recorded here.',
    })
    .meta({
      access: requires('procurement.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: orderParams, body: commitmentInputSchema }))
    .output(commitmentSchema),
  recordReceipt: endpoint
    .route({
      method: 'POST',
      path: `${path}/purchase-orders/{purchaseOrderId}/receipts`,
      summary: 'Record receipt or reconcile missing and damaged goods',
      description:
        'Requires procurement.manage. Records cumulative quantities with a person, time, reason and evidence. Manual receipt is allowed only for open Luma orders without a purchasing system. Corrections append evidence and require the current commitment ID.',
    })
    .meta({
      access: requires('procurement.manage'),
      errors: [400, 401, 403, 404, 409, 503],
    })
    .input(z.object({ params: orderParams, body: receiptInputSchema }))
    .output(commitmentSchema),
  reviewCommitment: endpoint
    .route({
      method: 'POST',
      path: `${path}/commitments/{commitmentId}/review`,
      summary: 'Confirm or reject an extracted commitment',
      description:
        'Requires `procurement.manage`. Confirms or rejects a commitment that needed review. `acceptChange` also accepts a quantity or date change.',
    })
    .meta({
      access: requires('procurement.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: commitmentParams, body: reviewInputSchema }))
    .output(commitmentSchema),
  respond: endpoint
    .route({
      method: 'POST',
      path: `${path}/purchase-orders/{purchaseOrderId}/follow-ups`,
      summary: 'Respond to a change or missed deadline',
      description:
        'Requires `procurement.manage`. Accepts a supplier change, or records a follow-up with when Luma should check again (within 60 days). The key must be one of the order’s current attention items.',
    })
    .meta({
      access: requires('procurement.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: orderParams, body: followUpInputSchema }))
    .output(followUpSchema),
  transition: endpoint
    .route({
      method: 'POST',
      path: `${path}/purchase-orders/{purchaseOrderId}/transitions`,
      summary: 'Change purchase order status',
      description:
        'Requires `procurement.manage`. Moves drafts to open or cancelled, and open orders to closed. Unsent local open orders may be cancelled; native orders already submitting, uncertain or submitted require supported and verified source cancellation. Provide the current revision and a reason. Reuse the command ID and body on retry. Closing records completion; it does not record a warehouse receipt.',
    })
    .meta({
      access: requires('procurement.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: orderParams, body: transitionInputSchema }))
    .output(purchaseOrderSchema),
};
