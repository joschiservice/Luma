import { z } from 'zod';

import { purchaseOrderInputSchema } from './validation.js';

/** Requires a reviewed reason for every source revision, including changes to confirmed units. */
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
