import { z } from 'zod';

/** Builds a validator for Shopify global IDs of the requested resource type. */
export const gid = (type: string) =>
  z.string().regex(new RegExp(`^gid://shopify/${type}/[0-9]+$`));

export const timestamp = z.string().datetime({ offset: true });

export const count = z.number().int().min(0).max(2147483647);

export const pageInfo = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().min(1).nullable(),
});

/** Builds a Shopify GraphQL connection validator for the supplied node schema. */
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
  totalQuantity: count,
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
