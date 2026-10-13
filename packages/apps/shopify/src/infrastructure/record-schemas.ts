import { connection, gid, timestamp } from '@luma/connector-shopify/schemas';
import { z } from 'zod';

const money = z.object({ amount: z.string(), currencyCode: z.string() });
const moneyBag = z.object({ shopMoney: money });
const identity = (type: string) => z.object({ id: gid(type) });

export const orderDetail = identity('Order').extend({
  name: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  displayFinancialStatus: z.string().nullable(),
  displayFulfillmentStatus: z.string(),
  currentTotalPriceSet: moneyBag,
  totalOutstandingSet: moneyBag,
});

export const transaction = identity('OrderTransaction').extend({
  createdAt: timestamp,
  processedAt: timestamp.nullable(),
  kind: z.string(),
  status: z.string(),
  gateway: z.string().nullable(),
  amountSet: moneyBag,
  parentTransaction: identity('OrderTransaction').nullable(),
});

export const customer = identity('Customer').extend({
  updatedAt: timestamp,
  numberOfOrders: z.string(),
  amountSpent: money,
});

export const refund = identity('Refund').extend({
  createdAt: timestamp,
  updatedAt: timestamp,
  totalRefundedSet: moneyBag,
  order: identity('Order'),
});

export const returnRecord = identity('Return').extend({
  name: z.string(),
  status: z.string(),
  order: identity('Order'),
});

export const fulfillmentOrderDetail = identity('FulfillmentOrder').extend({
  updatedAt: timestamp,
  status: z.string(),
  requestStatus: z.string(),
  order: identity('Order'),
  assignedLocation: z.object({ location: identity('Location').nullable() }),
  fulfillmentHolds: z.array(
    z.object({ id: gid('FulfillmentHold'), reason: z.string() }),
  ),
});

export const event = z.object({
  id: z.string().regex(/^gid:\/\/shopify\/(BasicEvent|CommentEvent)\/[0-9]+$/),
  createdAt: timestamp,
  action: z.string().optional(),
});

export const variantDetail = identity('ProductVariant').extend({
  title: z.string(),
  sku: z.string().nullable(),
  price: z.string(),
  updatedAt: timestamp,
  product: identity('Product'),
  inventoryItem: identity('InventoryItem'),
});

export const productDetail = identity('Product').extend({
  title: z.string(),
  status: z.string(),
  updatedAt: timestamp,
});

export const inventoryDetail = identity('InventoryItem').extend({
  tracked: z.boolean(),
  updatedAt: timestamp,
  sku: z.string().nullable(),
  variant: identity('ProductVariant'),
});

export const inventoryLevel = z.object({
  isActive: z.boolean().nullable().optional(),
  id: z.string().startsWith('gid://shopify/InventoryLevel/'),
  updatedAt: timestamp,
  location: identity('Location').extend({
    name: z.string(),
    isActive: z.boolean(),
  }),
  quantities: z.array(
    z.object({ name: z.string(), quantity: z.number().int() }),
  ),
});

export const line = identity('LineItem').extend({
  name: z.string(),
  quantity: z.number().int(),
  variant: identity('ProductVariant').nullable(),
});

export const returnLine = z.object({
  id: z.string(),
  quantity: z.number().int(),
  returnReasonDefinition: z.object({ name: z.string() }).nullable().optional(),
  fulfillmentLineItem: z.object({ lineItem: identity('LineItem') }).optional(),
});

export { connection };
