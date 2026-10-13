import { z } from 'zod';

import {
  purchaseOrderInputSchema,
  purchaseOrderSchema,
} from './procurement.js';

export const purchaseOrderChangeInputSchema = z
  .object({
    id: z.string().uuid(),
    expectedRevision: z.number().int().positive(),
    reason: z.string().trim().min(1).max(1000),
    operation: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('update_line'),
          lineId: z.string().uuid(),
          quantity: z.number().finite().positive().max(1e9).optional(),
          requestedDeliveryDate: z.string().date().optional(),
        })
        .strict()
        .refine(
          (value) =>
            value.quantity !== undefined ||
            value.requestedDeliveryDate !== undefined,
        ),
      z
        .object({
          kind: z.literal('add_line'),
          line: purchaseOrderInputSchema.shape.lines.element,
          requestedDeliveryDate: z.string().date(),
        })
        .strict(),
      z
        .object({ kind: z.literal('remove_line'), lineId: z.string().uuid() })
        .strict(),
      z.object({ kind: z.literal('cancel') }).strict(),
    ]),
  })
  .strict();

export const purchaseOrderChangeSchema = z.object({
  id: z.string().uuid(),
  purchaseOrderId: z.string().uuid(),
  request: purchaseOrderChangeInputSchema,
  state: z.enum([
    'preparing',
    'approval_required',
    'approved',
    'rejected',
    'submitting',
    'uncertain',
    'verified',
    'failed',
    'expired',
  ]),
  requestedBy: z.string(),
  requestedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  baseline: purchaseOrderSchema,
  proposed: purchaseOrderSchema,
  affectsCommitments: z.boolean(),
  canApprove: z.boolean().optional(),
  decidedBy: z.string().nullable(),
  verifiedAt: z.string().datetime().nullable(),
  observationRefs: z.array(z.string()),
  failure: z.string().nullable(),
});

export const purchaseOrderRevisionSchema = z.object({
  order: purchaseOrderSchema,
  changeId: z.string().uuid().nullable(),
  reason: z.string(),
  recordedBy: z.string(),
  recordedAt: z.string().datetime(),
  observationRefs: z.array(z.string()),
});

export type PurchaseOrderChangeInput = z.input<
  typeof purchaseOrderChangeInputSchema
>;
