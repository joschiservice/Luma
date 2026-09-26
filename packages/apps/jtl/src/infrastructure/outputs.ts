import { z } from 'zod';

const timestamp = z.string().datetime({ offset: true });

const externalId = z
  .object({ externalId: z.string().min(1), scopeKey: z.string() })
  .strict();

const decimal = z.string().regex(/^-?\d{1,14}(\.\d{1,6})?$/);

const quantity = z.object({ amount: decimal, unit: z.string().min(1) });

const observation = <T extends z.ZodTypeAny>(resource: string, data: T) =>
  z.object({
    id: z.string().uuid(),
    source: externalId.extend({
      tenantId: z.string().min(1),
      connectionId: z.string().min(1),
      provider: z.literal('jtl'),
      resource: z.literal(resource),
    }),
    kind: z.literal('snapshot'),
    observedAt: timestamp,
    sourceUpdatedAt: timestamp.nullable(),
    sourceRevision: z.string().nullable(),
    adapterVersion: z.literal('jtl/0'),
    schemaVersion: z.literal(1),
    data,
  });

const page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    completeness: z.enum(['complete', 'partial']),
  });

export const outputs = {
  'orders.read': page(
    observation(
      'order',
      z.object({
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
          z.object({
            id: externalId,
            sku: externalId.nullable(),
            quantity,
            cancelledQuantity: quantity.nullable(),
          }),
        ),
      }),
    ),
  ),
  'products.read': page(
    observation(
      'product',
      z.object({
        title: z.string().nullable(),
        status: z.enum(['active', 'archived', 'unknown']),
        skus: z.array(
          z.object({
            id: externalId,
            code: z.string().nullable(),
            unit: z.string().min(1),
          }),
        ),
      }),
    ),
  ),
  'inventory.read': page(
    observation(
      'sku',
      z.object({
        sku: externalId,
        location: externalId,
        unit: z.string().min(1),
        onHand: decimal.nullable(),
        reserved: decimal.nullable(),
        available: decimal.nullable(),
        availabilityBasis: z.enum(['provider_reported', 'unknown']),
      }),
    ),
  ),
  'fulfillment.read': page(
    observation(
      'fulfillment',
      z.object({
        order: externalId,
        status: z.enum([
          'pending',
          'processing',
          'shipped',
          'delivered',
          'cancelled',
          'failed',
          'unknown',
        ]),
        lines: z.array(z.object({ orderLine: externalId, quantity })),
        lastProgressAt: timestamp.nullable(),
        progressBasis: z
          .enum(['note_created_or_package_shipped', 'source_updated'])
          .optional(),
        failureCode: z.string().nullable(),
      }),
    ),
  ),
};
