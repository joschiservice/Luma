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

const external = z
  .object({
    externalId: z.string().min(1).max(1024),
    scopeKey: z.string().max(1024),
  })
  .strict();

export const sourceSchema = external
  .extend({
    tenantId: uuid,
    connectionId: uuid,
    provider: z.string().min(1).max(100),
    resource: z.enum([
      'order',
      'order_line',
      'fulfillment',
      'sku',
      'location',
      'product',
    ]),
  })
  .strict();

const quantity = z.object({ amount: positive, unit }).strict();

const observation = <T extends z.ZodTypeAny>(
  resource: 'order' | 'sku' | 'fulfillment',
  data: T,
) =>
  z
    .object({
      id: uuid,
      source: sourceSchema.extend({ resource: z.literal(resource) }),
      kind: z.enum(['snapshot', 'tombstone']),
      observedAt: timestamp,
      sourceUpdatedAt: timestamp.nullable(),
      sourceRevision: z.string().nullable(),
      adapterVersion: z.string().min(1),
      schemaVersion: z.literal(1),
      data,
    })
    .strict();

export const commerceSchema = z.discriminatedUnion('capability', [
  z
    .object({
      capability: z.literal('orders.read'),
      observation: observation(
        'order',
        z
          .object({
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
            lines: z.array(
              z
                .object({
                  id: external,
                  sku: external.nullable(),
                  quantity,
                  cancelledQuantity: z
                    .object({ amount: decimal, unit })
                    .strict()
                    .nullable(),
                })
                .strict()
                .refine(
                  (v) =>
                    v.cancelledQuantity === null ||
                    (v.cancelledQuantity.unit === v.quantity.unit &&
                      !v.cancelledQuantity.amount.startsWith('-') &&
                      units(v.cancelledQuantity.amount) <=
                        units(v.quantity.amount)),
                ),
            ),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      capability: z.literal('inventory.read'),
      observation: observation(
        'sku',
        z
          .object({
            sku: external,
            location: external,
            unit,
            onHand: decimal.nullable(),
            reserved: decimal.nullable(),
            available: decimal.nullable(),
            availabilityBasis: z.enum([
              'provider_reported',
              'derived',
              'unknown',
            ]),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      capability: z.literal('fulfillment.read'),
      observation: observation(
        'fulfillment',
        z
          .object({
            order: external,
            status: z.enum([
              'pending',
              'processing',
              'completed',
              'shipped',
              'delivered',
              'cancelled',
              'failed',
              'unknown',
            ]),
            lines: z.array(
              z.object({ orderLine: external, quantity }).strict(),
            ),
            lastProgressAt: timestamp.nullable(),
            progressBasis: z
              .enum(['note_created_or_package_shipped', 'source_updated'])
              .optional(),
            failureCode: z.string().nullable(),
          })
          .strict(),
      ),
    })
    .strict(),
]);
