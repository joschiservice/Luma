import { gid, timestamp } from '@luma/connector-shopify/schemas';
import { z } from 'zod';

export * from '@luma/connector-shopify/schemas';

const externalId = z
  .object({ externalId: z.string().min(1), scopeKey: z.string() })
  .strict();

const decimal = z.string().regex(/^-?\d{1,14}(\.\d{1,6})?$/);

const quantity = z.object({ amount: decimal, unit: z.literal('each') });

const observation = <T extends z.ZodTypeAny>(resource: string, data: T) =>
  z.object({
    id: z.string().uuid(),
    source: externalId.extend({
      tenantId: z.string().min(1),
      connectionId: z.string().min(1),
      provider: z.literal('shopify'),
      resource: z.literal(resource),
    }),
    kind: z.literal('snapshot'),
    observedAt: timestamp,
    sourceUpdatedAt: timestamp.nullable(),
    sourceRevision: z.string().nullable(),
    adapterVersion: z.literal('shopify/0'),
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
            unit: z.literal('each'),
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
        unit: z.literal('each'),
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
          'completed',
          'shipped',
          'delivered',
          'cancelled',
          'failed',
          'unknown',
        ]),
        lines: z.array(z.object({ orderLine: externalId, quantity })),
        lastProgressAt: timestamp.nullable(),
        failureCode: z.string().nullable(),
      }),
    ),
  ),
};

const pageInput = z
  .object({
    limit: z.number().int().min(1).max(100),
    cursor: z.string().min(1).max(8192).optional(),
  })
  .strict();

const scoped = (type: string) =>
  z.object({ externalId: gid(type), scopeKey: z.literal('') }).strict();

export const inputs = {
  'orders.read': pageInput,
  'products.read': pageInput,
  'inventory.read': pageInput.extend({
    sku: scoped('InventoryItem').optional(),
    location: scoped('Location').optional(),
  }),
  'fulfillment.read': pageInput.extend({ order: scoped('Order').optional() }),
};
