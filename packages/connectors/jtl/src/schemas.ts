import { z } from 'zod';

export const externalId = z.union([
  z
    .string()
    .uuid()
    .refine((value) => value !== '00000000-0000-0000-0000-000000000000'),
  z
    .string()
    .regex(/^[1-9]\d*$/)
    .refine((value) => Number(value) <= 2147483647),
]);

export const id = z
  .union([externalId, z.number().int().positive().max(2147483647)])
  .transform(String);

export const timestamp = z
  .string()
  .datetime({ offset: true })
  .refine((value) => !value.startsWith('0001-'));

// Reject values outside the canonical precision instead of silently rounding them.
export const decimal = z
  .union([z.number().finite(), z.string()])
  .transform(String)
  .refine((value) => /^-?\d{1,14}(\.\d{1,6})?$/.test(value));

export const order = z.object({
  id,
  salesOrderNumber: z.string(),
  externalSalesOrderNumber: z.string().nullable().optional().catch(null),
  isCancelled: z.boolean(),
  deliveryStatus: z.number().int(),
  paymentStatus: z.number().int(),
  // Descriptive facts become unknown when malformed; they never block the order's status read.
  salesOrderDate: timestamp.nullable().optional().catch(null),
  totalGrossAmount: decimal.nullable().optional().catch(null),
  currencyIso: z.string().nullable().optional().catch(null),
});

export const orderLine = z.object({
  id,
  salesOrderId: id,
  itemId: z.union([
    id,
    z.literal(0),
    z.literal('00000000-0000-0000-0000-000000000000'),
    z.null(),
  ]),
  quantity: decimal,
  salesUnit: z.string().min(1),
  name: z.string().nullable().optional().catch(null),
  sKU: z.string().nullable().optional().catch(null),
});

export const item = z.object({
  id,
  sKU: z.string(),
  name: z.string().nullable().optional(),
  unit: z.string().optional(),
  isActive: z.boolean(),
  isInventoryManagementActive: z.boolean(),
  modifiedTimestamp: timestamp.nullable().optional(),
  stockTotal: decimal.nullable().optional(),
  stockReservedTotal: decimal.nullable().optional(),
  stockAvailable: decimal.nullable().optional(),
  // Descriptive catalog facts become unknown when malformed; they never block the item read.
  salesPriceGross: decimal.nullable().optional().catch(null),
  gTIN: z.string().nullable().optional().catch(null),
  manufacturerName: z.string().nullable().optional().catch(null),
  isShopActive: z.boolean().nullable().optional().catch(null),
});

export const warehouseStock = z.object({
  totalQuantity: decimal,
  lockedQuantity: decimal,
});

export const note = z.object({
  id,
  salesOrderId: id,
  deliveryNoteDate: timestamp,
  packages: z.array(
    z.object({
      id,
      deliveryNoteId: id,
      shippingDate: timestamp.nullable().optional(),
      trackingNumber: z.string().nullable().optional().catch(null),
      trackingID: z.string().nullable().optional().catch(null),
      trackingUrl: z.string().nullable().optional().catch(null),
    }),
  ),
});

export const noteLine = z.object({
  id,
  deliveryNoteId: id,
  salesOrderLineItemId: id,
  quantity: decimal.refine((value) => Number(value) > 0),
});

/** Builds a JTL page validator for the supplied row schema, including pagination metadata. */
export const page = <T extends z.ZodTypeAny>(row: T) =>
  z.object({
    items: z.array(row),
    pageNumber: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    totalItems: z.number().int().nonnegative(),
    hasNextPage: z.boolean().optional(),
    nextPageNumber: z.number().int().optional(),
  });

export const shippingMethodState = z.object({
  id,
  shippingDetails: z
    .object({
      shippingDate: z.string().datetime({ offset: true }).nullable().optional(),
    })
    .optional(),
  shippingMethodId: id,
  isCancelled: z.boolean(),
});

export const shippingMethodResponse = z.object({ salesOrderId: id });

// JTL date-times may omit an offset; only the calendar date is read from them.
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(?:$|T)/)
  .transform((value) => value.slice(0, 10))
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));

/** Supplier overview row. The overview lists only active default-type suppliers. */
export const supplier = z.object({
  id,
  name: z.string().nullable().optional().catch(null),
  companyName: z.string().nullable().optional().catch(null),
  supplierNumber: z.string().nullable().optional().catch(null),
});

/** Supplier detail; only identity, activity and the contact email are read. */
export const supplierDetail = supplier.extend({
  isActive: z.boolean(),
  contact: z
    .object({ emailAddress: z.string().nullable().optional().catch(null) })
    .nullable()
    .optional()
    .catch(null),
});

/** One supplier assignment of an item, with the supplier's purchase price and VAT rate. */
export const itemSupplier = z.object({
  id,
  itemId: id,
  supplierId: id,
  netPurchasePrice: decimal.nullable().optional(),
  vatRate: decimal.nullable().optional(),
});

/** Purchase-order overview row; the detail is read for every consumed field. */
export const purchaseOrderListItem = z.object({ purchaseOrderId: id });

const lumaOrderMarker = /luma-po:([A-Za-z0-9][A-Za-z0-9_-]{0,127})/g;

/**
 * Purchase-order detail. The internal comment is reduced to the Luma order markers it carries;
 * its text, addresses and prices are never retained.
 */
export const purchaseOrder = z
  .object({
    purchaseOrderId: id,
    supplierId: id,
    orderNumber: z.string().nullable().optional().catch(null),
    status: z.number().int(),
    isConfirmed: z.boolean(),
    requestedDeliveryDate: calendarDate.nullable().optional().catch(null),
    createdAt: timestamp.nullable().optional().catch(null),
    internalComment: z.string().nullable().optional().catch(null),
    lineItems: z.array(
      z.object({
        lineItemId: id,
        lineItemType: z.number().int(),
        itemId: id.nullable().optional(),
        itemNumber: z.string().nullable().optional().catch(null),
        quantity: decimal,
        deliveredQuantity: decimal,
        openQuantity: decimal,
        confirmedQuantity: decimal.nullable().optional(),
        confirmedDeliveryDate: calendarDate.nullable().optional().catch(null),
        isLineItemConfirmed: z.boolean().nullable().optional(),
        deliveryDate: calendarDate.nullable().optional().catch(null),
      }),
    ),
  })
  .transform(({ internalComment, ...order }) => ({
    ...order,
    lumaOrderIds: [
      ...new Set(
        [...(internalComment ?? '').matchAll(lumaOrderMarker)].map(
          (match) => match[1]!,
        ),
      ),
    ],
  }));

export const purchaseOrderCreated = z.object({ purchaseOrderId: id });
