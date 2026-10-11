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
  // 0 and null mean no customer; a malformed value leaves the customer unknown.
  customerId: z
    .union([id, z.literal(0), z.null()])
    .optional()
    .catch(undefined),
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

const optionalText = z.string().nullable().optional().catch(null);

/** Customer overview row; descriptive fields become unknown when missing or malformed. */
export const customer = z.object({
  id,
  customerNumber: optionalText,
  firstName: optionalText,
  lastName: optionalText,
  companyName: optionalText,
  emailAddress: optionalText,
  phoneNumber: optionalText,
  mobilePhoneNumber: optionalText,
  street: optionalText,
  additionalAddressLine: optionalText,
  postalCode: optionalText,
  city: optionalText,
  state: optionalText,
  countryIso: optionalText,
  countryName: optionalText,
  createdDate: timestamp.nullable().optional().catch(null),
  lastChanged: timestamp.nullable().optional().catch(null),
  isLocked: z.boolean().nullable().optional().catch(null),
  labels: optionalText,
});

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

/** Sales-order detail facts a return needs: its company and whether it is cancelled. */
export const salesOrderCompany = z.object({
  id,
  companyId: id,
  isCancelled: z.boolean(),
});

/** Warehouse overview row; a malformed name or activity becomes unknown. */
export const warehouse = z.object({
  id,
  name: z.string().nullable().optional().catch(null),
  active: z.boolean().optional().catch(undefined),
});

/** Return reason with its translated names; malformed translations leave the name unknown. */
export const returnReason = z.object({
  id,
  translations: z
    .array(
      z.object({
        languageIso: z.string(),
        name: z.string().nullable().optional().catch(null),
      }),
    )
    .nullable()
    .optional()
    .catch(null),
});

// JTL reports a missing reference as null, zero or the empty UUID.
const optionalReference = z
  .union([
    id,
    z.literal(0),
    z.literal('00000000-0000-0000-0000-000000000000'),
    z.null(),
  ])
  .optional()
  .transform((value) =>
    value === undefined ||
    value === null ||
    value === 0 ||
    value === '00000000-0000-0000-0000-000000000000'
      ? null
      : value,
  );

/**
 * Return as listed and created. Only identity, order, warehouse, date, number and the external
 * number that carries Luma's marker are read; comments, contact and customer are never kept.
 */
export const returnRow = z.object({
  id,
  number: z.string().nullable().optional().catch(null),
  returnDate: timestamp.nullable().optional().catch(null),
  externalNumber: z.string().nullable().optional().catch(null),
  salesOrderId: id,
  warehouseId: optionalReference.catch(null),
});

/** Return line; its sales-order line and reason are optional references. */
export const returnLine = z.object({
  id,
  returnId: id,
  quantity: decimal,
  returnReasonId: optionalReference,
  salesOrderLineItemId: optionalReference,
});

/** The created return in a 201 response; only its ID is consumed. */
export const returnCreated = z.object({ id });
