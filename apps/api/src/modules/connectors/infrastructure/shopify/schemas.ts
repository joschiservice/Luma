import { z } from 'zod';

export const gid = (type: string) =>
  z.string().regex(new RegExp(`^gid://shopify/${type}/[0-9]+$`));
export const timestamp = z.string().datetime({ offset: true });
export const count = z.number().int().min(0).max(2147483647);
export const pageInfo = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().min(1).nullable(),
});
export const connection = <T extends z.ZodTypeAny>(node: T) =>
  z.object({ nodes: z.array(node), pageInfo });
export const orderLine = z.object({
  id: gid('LineItem'),
  quantity: count,
  variant: z
    .object({ inventoryItem: z.object({ id: gid('InventoryItem') }) })
    .nullable(),
});
export const order = z.object({
  id: gid('Order'),
  updatedAt: timestamp,
  name: z.string(),
  cancelledAt: timestamp.nullable(),
  closed: z.boolean(),
  displayFinancialStatus: z.string().nullable(),
});
export const variant = z.object({
  id: gid('ProductVariant'),
  sku: z.string().nullable(),
  inventoryItem: z.object({ id: gid('InventoryItem') }),
});
export const product = z.object({
  id: gid('Product'),
  updatedAt: timestamp,
  title: z.string(),
  status: z.string(),
});
export const inventoryItem = z.object({
  id: gid('InventoryItem'),
  tracked: z.boolean(),
});
export const level = z.object({
  id: z.string().regex(/^gid:\/\/shopify\/InventoryLevel\//),
  updatedAt: timestamp,
  location: z.object({ id: gid('Location') }),
  quantities: z.array(
    z.object({
      name: z.string(),
      quantity: z.number().int().min(-2147483648).max(2147483647),
    }),
  ),
});
export const fulfillmentOrder = z.object({
  id: gid('FulfillmentOrder'),
  updatedAt: timestamp,
  status: z.string(),
});
export const fulfillmentOrderLine = z.object({
  id: gid('FulfillmentOrderLineItem'),
  remainingQuantity: count,
  lineItem: z.object({ id: gid('LineItem') }),
});
export const fulfillment = z.object({
  id: gid('Fulfillment'),
  updatedAt: timestamp,
  status: z.string(),
  deliveredAt: timestamp.nullable(),
  inTransitAt: timestamp.nullable(),
});
export const fulfillmentLine = z.object({
  id: gid('FulfillmentLineItem'),
  quantity: count,
  lineItem: z.object({ id: gid('LineItem') }),
});

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
