import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import {
  apiErrorSchema,
  organizationParamsSchema,
  requires,
} from '../common.js';
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
  purchaseOrderRecordSchema,
  purchaseOrderSchema,
  purchasingConnectionSchema,
  purchasingSupplierSchema,
  reviewInputSchema,
  submissionDecisionSchema,
  submissionInputSchema,
  submissionViewSchema,
  supplierInputSchema,
  supplierLinkInputSchema,
  supplierRecordSchema,
  supplierSchema,
  transitionInputSchema,
} from '../procurement.js';

const c = initContract();
const path = '/v1/organizations/:organizationId/procurement';
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

export const procurementContract = c.router(
  {
    suppliers: {
      method: 'GET',
      metadata: requires('procurement.read'),
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
      metadata: requires('procurement.manage'),
      path: `${path}/suppliers`,
      pathParams: organizationParamsSchema,
      body: supplierInputSchema,
      responses: { 200: supplierSchema },
      summary: 'Create a supplier',
      description:
        'Requires `procurement.manage`. Retry with the same ID and body after an uncertain response.',
    },
    orders: {
      method: 'GET',
      metadata: requires('procurement.read'),
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
      metadata: requires('procurement.manage'),
      path: `${path}/purchase-orders`,
      pathParams: organizationParamsSchema,
      body: purchaseOrderInputSchema,
      responses: { 200: purchaseOrderSchema },
      summary: 'Create a purchase order',
      description:
        'Requires `procurement.manage`. Creates a draft with immutable lines and provenance. Luma-owned orders support audited lifecycle changes. External ownership requires an external reference and prevents local lifecycle changes. Reuse the ID and body on retry.',
    },
    detail: {
      method: 'GET',
      metadata: requires('procurement.read'),
      path: `${path}/purchase-orders/:purchaseOrderId`,
      pathParams: orderParams,
      responses: { 200: purchaseOrderDetailSchema },
      summary: 'Read a purchase order and its lifecycle history',
    },
    supplier: {
      method: 'GET',
      metadata: requires('procurement.read'),
      path: `${path}/suppliers/:supplierId`,
      pathParams: supplierParams,
      responses: { 200: supplierRecordSchema },
      summary: 'Read a supplier record',
      description:
        'Returns the supplier, its purchasing-system link, every purchase order with its stage and progress, and recent supplier messages. Stages come from recorded evidence: confirmation and receipt are read from the purchasing system or recorded from supplier messages; receipt only from the purchasing system.',
    },
    linkSupplier: {
      method: 'POST',
      metadata: requires('procurement.manage'),
      path: `${path}/suppliers/:supplierId/link`,
      pathParams: supplierParams,
      body: supplierLinkInputSchema,
      responses: { 200: supplierSchema },
      summary: 'Link a supplier to its purchasing-system record',
      description:
        'Requires `procurement.manage`. Links the supplier to a supplier in a connected purchasing system, or removes the link, and sets how many hours the supplier has to confirm a sent order. Provide the current revision. The purchasing-system supplier is read again before it is linked.',
    },
    purchasingConnections: {
      method: 'GET',
      metadata: requires('procurement.read'),
      path: `${path}/purchasing-connections`,
      pathParams: organizationParamsSchema,
      responses: { 200: z.array(purchasingConnectionSchema) },
      summary: 'List purchasing-system connections',
      description:
        'Connections that requested supplier or purchase-order access, with what they are currently allowed to do.',
    },
    purchasingSuppliers: {
      method: 'GET',
      metadata: requires('procurement.manage'),
      path: `${path}/purchasing-connections/:connectionId/suppliers`,
      pathParams: connectionParams,
      query: z.object({ cursor: z.string().max(4096).optional() }),
      responses: {
        200: z.object({
          items: z.array(purchasingSupplierSchema),
          nextCursor: z.string().nullable(),
        }),
      },
      summary: 'List suppliers in a purchasing system',
      description:
        'Requires `procurement.manage`. Reads up to 100 suppliers per page from the connection, for linking. Nothing is stored.',
    },
    progress: {
      method: 'GET',
      metadata: requires('procurement.read'),
      path: `${path}/purchase-orders/progress`,
      pathParams: organizationParamsSchema,
      responses: { 200: z.object({ items: z.array(orderSummarySchema) }) },
      summary: 'Summarize purchase-order progress',
      description:
        'One stage per order (draft, sending, awaiting confirmation, confirmed, changed, partially received, received, closed or cancelled), with the earliest expected date of outstanding units, how many items need attention and who acts next.',
    },
    record: {
      method: 'GET',
      metadata: requires('procurement.read'),
      path: `${path}/purchase-orders/:purchaseOrderId/record`,
      pathParams: orderParams,
      responses: { 200: purchaseOrderRecordSchema },
      summary: 'Read a purchase order record with its supplier lifecycle',
      description:
        'Returns the order, lifecycle history, its submission to a purchasing system, supplier messages and extraction attempts, every commitment with its source, purchasing-system reads, follow-up responses and derived progress. A draft, a sent order, a supplier confirmation and a booked goods receipt are separate milestones; only the purchasing system establishes receipt.',
    },
    refresh: {
      method: 'POST',
      metadata: requires('procurement.read'),
      path: `${path}/purchase-orders/:purchaseOrderId/refresh`,
      pathParams: orderParams,
      body: z.object({}).strict(),
      responses: { 200: purchaseOrderRecordSchema },
      summary: 'Read the purchasing system now',
      description:
        'Reads the order in its purchasing system and records any new confirmation or receipt. Requires `procurement.read`.',
    },
    requestSubmission: {
      method: 'POST',
      metadata: requires('procurement.manage'),
      path: `${path}/purchase-orders/:purchaseOrderId/submissions`,
      pathParams: orderParams,
      body: submissionInputSchema,
      responses: { 200: submissionViewSchema },
      summary: 'Request approval to send an order to the supplier',
      description:
        'Requires `procurement.manage`. Asks for approval to place this draft or open order in the supplier’s linked purchasing system, with a requested delivery date. Someone else with `procurement.manage` and `decisions.respond` must approve. Every line’s SKU must be linked to a purchasing-system item. After approval Luma places the order once and verifies it with an independent read; the purchasing system sends it to the supplier. Reuse the ID and body after an uncertain response. Requests expire after 24 hours.',
    },
    decideSubmission: {
      method: 'POST',
      metadata: requires('procurement.manage'),
      path: `${path}/submissions/:submissionId/decision`,
      pathParams: submissionParams,
      body: submissionDecisionSchema,
      responses: { 200: submissionViewSchema },
      summary: 'Approve or reject sending an order',
      description:
        'Requires `procurement.manage` and `decisions.respond`, plus any app permission the purchasing capability declares. Someone other than the requester approves or rejects the exact submission. Approval dispatches it as the requester after their membership, the order and the supplier link are checked again.',
    },
    sendSubmission: {
      method: 'POST',
      metadata: requires('procurement.manage'),
      path: `${path}/submissions/:submissionId/send`,
      pathParams: submissionParams,
      body: z.object({}).strict(),
      responses: { 200: submissionViewSchema },
      summary: 'Send an approved order now',
      description:
        'The requester dispatches an approved submission that has not been sent. Repeated calls return the recorded attempt.',
    },
    checkSubmission: {
      method: 'POST',
      metadata: requires('procurement.manage'),
      path: `${path}/submissions/:submissionId/check`,
      pathParams: submissionParams,
      body: z.object({}).strict(),
      responses: { 200: submissionViewSchema },
      summary: 'Check an uncertain submission',
      description:
        'Reads the purchasing system to settle whether an uncertain submission created the order. It never sends the order again.',
    },
    recordMessage: {
      method: 'POST',
      metadata: requires('procurement.manage'),
      path: `${path}/purchase-orders/:purchaseOrderId/messages`,
      pathParams: orderParams,
      body: messageInputSchema,
      responses: {
        200: z.object({
          communicationId: z.string().uuid(),
          duplicate: z.boolean(),
        }),
      },
      summary: 'Record a supplier message',
      description:
        'Requires `procurement.manage`. Records a supplier message for this order. When an EU model route is configured, Luma lists the commitments it states, each with the exact words it came from; changes, uncertain readings and conditions wait for review. The same message, by message ID or content, is recorded once. Text is removed after the retention period.',
    },
    readMessage: {
      method: 'POST',
      metadata: requires('procurement.manage'),
      path: `${path}/messages/:communicationId/read`,
      pathParams: messageParams,
      body: z.object({}).strict(),
      responses: { 200: extractionSchema },
      summary: 'Read a supplier message again',
      description:
        'Retries reading a message whose earlier attempts were unavailable or failed.',
    },
    removeMessageText: {
      method: 'POST',
      metadata: requires('procurement.manage'),
      path: `${path}/messages/:communicationId/remove-text`,
      pathParams: messageParams,
      body: z.object({}).strict(),
      responses: { 200: communicationSchema },
      summary: 'Remove a supplier message’s text',
      description:
        'Requires `procurement.manage`. Removes the subject and text now. The sender, time, content digest and recorded commitments remain; quotes can no longer be shown.',
    },
    recordCommitment: {
      method: 'POST',
      metadata: requires('procurement.manage'),
      path: `${path}/purchase-orders/:purchaseOrderId/commitments`,
      pathParams: orderParams,
      body: commitmentInputSchema,
      responses: { 200: commitmentSchema },
      summary: 'Record or correct a supplier commitment',
      description:
        'Requires `procurement.manage`. Records a confirmed quantity, promised date, shipment or condition by selecting the words in a supplier message, or corrects an earlier commitment with a reason. Corrections add a commitment; nothing is overwritten. Receipt cannot be recorded here.',
    },
    reviewCommitment: {
      method: 'POST',
      metadata: requires('procurement.manage'),
      path: `${path}/commitments/:commitmentId/review`,
      pathParams: commitmentParams,
      body: reviewInputSchema,
      responses: { 200: commitmentSchema },
      summary: 'Confirm or reject an extracted commitment',
      description:
        'Requires `procurement.manage`. Confirms or rejects a commitment that needed review. `acceptChange` also accepts a quantity or date change.',
    },
    respond: {
      method: 'POST',
      metadata: requires('procurement.manage'),
      path: `${path}/purchase-orders/:purchaseOrderId/follow-ups`,
      pathParams: orderParams,
      body: followUpInputSchema,
      responses: { 200: followUpSchema },
      summary: 'Respond to a change or missed deadline',
      description:
        'Requires `procurement.manage`. Accepts a supplier change, or records a follow-up with when Luma should check again (within 60 days). The key must be one of the order’s current attention items.',
    },
    transition: {
      method: 'POST',
      metadata: requires('procurement.manage'),
      path: `${path}/purchase-orders/:purchaseOrderId/transitions`,
      pathParams: orderParams,
      body: transitionInputSchema,
      responses: { 200: purchaseOrderSchema },
      summary: 'Change purchase order status',
      description:
        'Requires `procurement.manage`. Moves drafts to open or cancelled, and open orders to closed or cancelled. Provide the current revision and a reason. Reuse the command ID and body on retry. Closing records completion; it does not record a warehouse receipt.',
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
