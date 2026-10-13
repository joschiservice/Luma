import { z } from 'zod';

/** Cin7 record IDs are GUIDs; the all-zero GUID means none. */
export const guid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  .refine((value) => value !== '00000000-0000-0000-0000-000000000000');

/**
 * Decimal amounts as exact strings. Cin7 pads some values with trailing zeros, which are
 * removed; values beyond fourteen integer or six fractional digits are rejected, not rounded.
 */
export const decimal = z
  .union([z.number().finite(), z.string()])
  .transform((value, context) => {
    const text = String(value).trim();
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
    const fraction = match?.[3]?.replace(/0+$/, '') ?? '';
    const integer = match?.[2]?.replace(/^0+(?=\d)/, '') ?? '';
    if (!match || integer.length > 14 || fraction.length > 6) {
      context.addIssue({ code: 'custom', message: 'Unsupported decimal' });

      return z.NEVER;
    }
    const result = `${match[1]}${integer}${fraction ? `.${fraction}` : ''}`;

    return result === '-0' ? '0' : result;
  });

/**
 * Cin7 reports UTC times, with or without a zone designator and with up to seven fractional
 * digits. They are normalized to ISO 8601 with millisecond precision.
 */
export const timestamp = z.string().transform((value, context) => {
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/.exec(
      value.trim(),
    );
  const time = match
    ? new Date(
        `${match[1]}T${match[2]}.${(match[3] ?? '').padEnd(3, '0').slice(0, 3)}${match[4] ?? 'Z'}`,
      )
    : null;
  if (!time || Number.isNaN(time.getTime()) || time.getUTCFullYear() < 1900) {
    context.addIssue({ code: 'custom', message: 'Unsupported timestamp' });

    return z.NEVER;
  }

  return time.toISOString();
});

// Descriptive text never blocks a record: malformed values become unknown.
const text = z.string().nullable().optional().catch(null);

const time = timestamp.nullable().optional().catch(null);

/** One page of a Cin7 list endpoint, whose items sit under an endpoint-specific key. */
export const page = <T extends z.ZodTypeAny>(key: string, item: T) =>
  z
    .looseObject({
      Total: z.number().int().nonnegative(),
      Page: z.number().int().positive(),
    })
    .transform((value, context) => {
      const items = z
        .array(item)
        .safeParse((value as Record<string, unknown>)[key]);
      if (!items.success) {
        context.addIssue({ code: 'custom', message: 'Invalid page items' });

        return z.NEVER;
      }

      return {
        total: value.Total,
        page: value.Page,
        items: items.data as z.infer<T>[],
      };
    });

export const me = z.object({ Company: z.string().nullable().optional() });

export const saleListItem = z.object({
  SaleID: guid,
  OrderNumber: text,
  Status: z.string(),
  OrderStatus: text,
  FulFilmentStatus: text,
  Updated: time,
});

const saleLine = z.object({
  ProductID: guid.nullable().optional().catch(null),
  SKU: text,
  Name: text,
  Quantity: decimal,
});

const fulfilmentLine = saleLine.extend({
  LocationID: guid.nullable().optional().catch(null),
  Location: text,
});

export const sale = z.object({
  ID: guid,
  CustomerID: guid.nullable().optional().catch(null),
  CustomerReference: text,
  SourceChannel: text,
  CustomerCurrency: text,
  SaleOrderDate: time,
  ShipBy: time,
  LastModifiedOn: time,
  Status: z.string(),
  CombinedPaymentStatus: text,
  FulFilmentStatus: text,
  Carrier: text,
  Order: z
    .object({
      SaleOrderNumber: text,
      Status: text,
      Lines: z.array(saleLine).default([]),
      Total: decimal.nullable().optional().catch(null),
    })
    .nullable()
    .optional(),
  Fulfilments: z
    .array(
      z.object({
        TaskID: guid,
        FulfillmentNumber: z.number().int().nullable().optional().catch(null),
        FulFilmentStatus: text,
        Pick: z
          .object({ Status: text, Lines: z.array(fulfilmentLine).default([]) })
          .nullable()
          .optional(),
        Pack: z
          .object({ Status: text, Lines: z.array(fulfilmentLine).default([]) })
          .nullable()
          .optional(),
        Ship: z
          .object({
            Status: text,
            RequireBy: time,
            Lines: z
              .array(
                z.object({
                  ShipmentDate: time,
                  Carrier: text,
                  TrackingNumber: text,
                  TrackingURL: text,
                  IsShipped: z.boolean().nullable().optional().catch(null),
                }),
              )
              .default([]),
          })
          .nullable()
          .optional(),
      }),
    )
    .default([]),
  CreditNotes: z
    .array(
      z.object({
        TaskID: guid,
        CreditNoteNumber: text,
        CreditNoteDate: time,
        Status: text,
        Lines: z.array(saleLine).default([]),
        Total: decimal.nullable().optional().catch(null),
        Refunds: z
          .array(
            z.object({
              Amount: decimal,
              DatePaid: time,
            }),
          )
          .default([]),
        Restock: z
          .array(
            saleLine.extend({
              RestockDate: time,
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

export const creditNoteListItem = z.object({
  SaleID: guid,
  Updated: time,
});

export const product = z.object({
  ID: guid,
  SKU: text,
  Name: text,
  Brand: text,
  Type: text,
  Status: z.string(),
  UOM: text,
  Barcode: text,
  PriceTier1: decimal.nullable().optional().catch(null),
  LastModifiedOn: time,
  Suppliers: z
    .array(
      z.object({
        SupplierID: guid,
        ProductSupplierID: guid.nullable().optional(),
        SupplierInventoryCode: text,
        Cost: decimal.nullable().optional(),
        FixedCost: decimal.nullable().optional(),
        Currency: text,
        ProductSupplierOptions: z
          .array(
            z.object({
              LocationID: guid.nullable().optional(),
              LocationName: text,
              Lead: z.number().int().nonnegative().nullable().optional(),
            }),
          )
          .optional(),
      }),
    )
    .max(100)
    .optional(),
});

export const availability = z.object({
  ID: guid,
  Location: z.string().min(1),
  OnHand: decimal.nullable().optional(),
  Allocated: decimal.nullable().optional(),
  Available: decimal.nullable().optional(),
});

export const location = z.object({ ID: guid, Name: z.string().min(1) });

const address = z.object({
  Line1: text,
  Line2: text,
  City: text,
  State: text,
  Postcode: text,
  Country: text,
  Type: text,
  DefaultForType: z.boolean().nullable().optional().catch(null),
});

const contact = z.object({
  Name: text,
  Phone: text,
  MobilePhone: text,
  Email: text,
  Default: z.boolean().nullable().optional().catch(null),
});

export const customer = z.object({
  ID: guid,
  Name: text,
  DisplayName: text,
  Status: z.string(),
  Tags: text,
  LastModifiedOn: time,
  Addresses: z.array(address).nullable().optional().catch(null),
  Contacts: z.array(contact).nullable().optional().catch(null),
});

export const supplier = z.object({
  ID: guid,
  Name: text,
  Status: z.string(),
  LastModifiedOn: time,
  Contacts: z.array(contact).nullable().optional().catch(null),
});

export const purchaseListItem = z.object({
  ID: guid,
  LastUpdatedDate: time,
});

export const purchase = z.object({
  ID: guid,
  SupplierID: guid,
  OrderNumber: text,
  OrderDate: time,
  RequiredBy: time,
  Status: z.string(),
  CombinedReceivingStatus: text,
  LastUpdatedDate: time,
  Order: z
    .object({
      Status: text,
      Lines: z.array(saleLine).default([]),
    })
    .nullable()
    .optional(),
  StockReceived: z
    .array(
      z.object({
        Status: text,
        Lines: z
          .array(
            saleLine.extend({
              Received: z.boolean().nullable().optional().catch(null),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});
