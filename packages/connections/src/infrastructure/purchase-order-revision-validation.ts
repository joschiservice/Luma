import { z } from 'zod';

const external = z
  .object({
    externalId: z.string().min(1).max(1024),
    scopeKey: z.string().max(1024),
  })
  .strict();
const decimal = z.string().regex(/^-?\d{1,14}(?:\.\d{1,6})?$/);
const date = z.string().date();
const quantity = z.number().finite().positive().max(1e9);
const expected = z
  .object({
    supplier: external,
    orderNumber: z.string().nullable(),
    lumaOrderId: z.string().nullable(),
    status: z.enum([
      'open',
      'released',
      'in_progress',
      'partially_delivered',
      'overdue',
      'completed',
      'unknown',
    ]),
    requestedDeliveryDate: date.nullable(),
    confirmed: z.boolean().nullable(),
    createdAt: z.string().datetime({ offset: true }).nullable(),
    lines: z
      .array(
        z.object({
          id: external,
          sku: external.nullable(),
          itemNumber: z.string().nullable(),
          quantity: z.object({ amount: decimal, unit: z.string().min(1) }),
          deliveredQuantity: decimal.nullable(),
          confirmedQuantity: decimal.nullable(),
          confirmedDeliveryDate: date.nullable(),
          confirmed: z.boolean().nullable(),
          requestedDeliveryDate: date.nullable(),
        }),
      )
      .max(100),
  })
  .strict();

/** Parses the frozen source state and one bounded operation before provider dispatch. */
export const purchaseOrderRevisionInputSchema = z
  .object({
    order: external,
    expected,
    operation: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('update_line'),
          line: external,
          quantity: quantity.optional(),
          requestedDeliveryDate: date.optional(),
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
          sku: external,
          quantity,
          requestedDeliveryDate: date,
        })
        .strict(),
      z.object({ kind: z.literal('remove_line'), line: external }).strict(),
    ]),
  })
  .strict();
