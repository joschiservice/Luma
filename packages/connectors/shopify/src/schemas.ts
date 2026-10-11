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

/** Shopify money in the shop currency. */
export const money = z.object({
  amount: z.string().regex(/^-?\d{1,14}(\.\d{1,6})?$/),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
});

export const orderLine = z
  .object({
    id: gid('LineItem'),
    quantity: count,
    currentQuantity: count,
    name: z.string().nullable().optional().catch(null),
    sku: z.string().nullable().optional().catch(null),
    originalUnitPriceSet: z
      .object({ shopMoney: money })
      .nullable()
      .optional()
      .catch(null),
    taxLines: z
      .array(z.object({ rate: z.number().min(0).max(1).nullable() }))
      .optional()
      .catch(undefined),
    variant: z
      .object({ inventoryItem: z.object({ id: gid('InventoryItem') }) })
      .nullable(),
  })
  .refine((line) => line.currentQuantity <= line.quantity);

export const order = z.object({
  id: gid('Order'),
  updatedAt: timestamp,
  name: z.string(),
  cancelledAt: timestamp.nullable(),
  closed: z.boolean(),
  displayFinancialStatus: z.string().nullable(),
  // Descriptive facts become unknown when malformed; they never block the order's status read.
  createdAt: timestamp.nullable().optional().catch(null),
  currentTotalPriceSet: z
    .object({ shopMoney: money })
    .nullable()
    .optional()
    .catch(null),
  // Requested only with customer access; null for orders without a customer.
  customer: z
    .object({ id: gid('Customer') })
    .nullable()
    .optional(),
});

export const variant = z.object({
  id: gid('ProductVariant'),
  sku: z.string().nullable(),
  inventoryItem: z.object({ id: gid('InventoryItem') }),
  // Descriptive facts become unknown when malformed; they never block the product read.
  title: z.string().nullable().optional().catch(null),
  price: z
    .string()
    .regex(/^-?\d{1,14}(\.\d{1,6})?$/)
    .nullable()
    .optional()
    .catch(null),
  barcode: z.string().nullable().optional().catch(null),
});

export const product = z.object({
  id: gid('Product'),
  updatedAt: timestamp,
  title: z.string(),
  status: z.string(),
  vendor: z.string().nullable().optional().catch(null),
  publishedAt: timestamp.nullable().optional().catch(null),
  // Variant prices are in the shop currency, which the price range reports.
  priceRangeV2: z
    .object({
      minVariantPrice: z.object({
        currencyCode: z.string().regex(/^[A-Z]{3}$/),
      }),
    })
    .nullable()
    .optional()
    .catch(null),
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

const optionalTime = timestamp.nullable().optional().catch(null);

const optionalText = z.string().nullable().optional().catch(null);

export const fulfillmentOrder = z.object({
  id: gid('FulfillmentOrder'),
  updatedAt: timestamp,
  status: z.string(),
  // Holds decide whether work is blocked, so a malformed list fails the read.
  fulfillmentHolds: z.array(z.object({ reason: z.string() })).optional(),
  assignedLocation: z
    .object({
      name: optionalText,
      location: z.object({ id: gid('Location') }).nullable(),
    })
    .nullable()
    .optional()
    .catch(null),
  fulfillAt: optionalTime,
  fulfillBy: optionalTime,
  deliveryMethod: z
    .object({ methodType: z.string(), presentedName: optionalText })
    .nullable()
    .optional()
    .catch(null),
});

export const fulfillmentOrderLine = z
  .object({
    id: gid('FulfillmentOrderLineItem'),
    totalQuantity: count,
    remainingQuantity: count,
    lineItem: z.object({ id: gid('LineItem') }),
  })
  .refine((line) => line.remainingQuantity <= line.totalQuantity);

export const fulfillment = z.object({
  id: gid('Fulfillment'),
  updatedAt: timestamp,
  status: z.string(),
  deliveredAt: timestamp.nullable(),
  inTransitAt: timestamp.nullable(),
  displayStatus: optionalText,
  estimatedDeliveryAt: optionalTime,
  location: z
    .object({ id: gid('Location'), name: optionalText })
    .nullable()
    .optional()
    .catch(null),
  trackingInfo: z
    .array(
      z.object({
        company: optionalText,
        number: optionalText,
        url: optionalText,
      }),
    )
    .optional()
    .catch([]),
});

export const fulfillmentLine = z.object({
  id: gid('FulfillmentLineItem'),
  quantity: count,
  lineItem: z.object({ id: gid('LineItem') }),
});
