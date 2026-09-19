import { z } from 'zod';
const uuid = z.string().uuid();
const decimal = z.string().regex(/^-?\d{1,14}(\.\d{1,6})?$/);
const units = (s: string) => {
  const [whole, fraction = ''] = s.replace('-', '').split('.');
  return BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, '0'));
};
const positive = decimal.refine((s) => !s.startsWith('-') && units(s) > 0n);
const timestamp = z.string().datetime({ offset: true });
const unit = z.string().min(1).max(64);
const base = z.object({
  schemaVersion: z.literal(1),
  entityId: uuid,
  connectionId: uuid,
  observationId: uuid,
  normalizerVersion: z.string().min(1),
  mappingVersion: z.string().regex(/^[a-f0-9]{64}$/),
  sourceRevision: z.string().nullable(),
  sourceUpdatedAt: timestamp.nullable(),
  observedAt: timestamp,
  deleted: z.boolean(),
});

const line = z
  .object({
    id: uuid,
    skuId: uuid.nullable(),
    quantity: positive,
    cancelledQuantity: decimal.nullable(),
    unit,
  })
  .strict()
  .refine(
    (v) =>
      v.cancelledQuantity === null ||
      (!v.cancelledQuantity.startsWith('-') &&
        units(v.cancelledQuantity) <= units(v.quantity)),
  );
const order = z
  .object({
    type: z.literal('order'),
    displayNumber: z.string().nullable(),
    status: z.enum(['open', 'completed', 'cancelled', 'unknown']),
    paymentStatus: z.enum([
      'pending',
      'authorized',
      'paid',
      'partially_refunded',
      'refunded',
      'failed',
      'unknown',
    ]),
    lines: z
      .array(line)
      .refine((v) => new Set(v.map((l) => l.id)).size === v.length),
  })
  .strict();
const fulfillment = z
  .object({
    type: z.literal('fulfillment'),
    orderId: uuid,
    status: z.enum([
      'pending',
      'processing',
      'shipped',
      'delivered',
      'cancelled',
      'failed',
      'unknown',
    ]),
    lastProgressAt: timestamp.nullable(),
    failureCode: z.string().nullable(),
    lines: z
      .array(z.object({ orderLineId: uuid, quantity: positive, unit }).strict())
      .refine((v) => new Set(v.map((l) => l.orderLineId)).size === v.length),
  })
  .strict();
export const snapshotSchema = z.union([
  base.extend({ kind: z.literal('order'), data: order }).strict(),
  base.extend({ kind: z.literal('fulfillment'), data: fulfillment }).strict(),
]);
