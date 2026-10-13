import { z } from 'zod';

const text = z.string().min(1).max(512);
const quantity = z.string().regex(/^\d{1,14}(\.\d{1,6})?$/);
const time = z.string().datetime({ offset: true });
const uniqueSources = (values: { externalId: string; scopeKey: string }[]) =>
  new Set(
    values.map((value) => JSON.stringify([value.externalId, value.scopeKey])),
  ).size === values.length;
const source = z
  .object({
    externalId: z.string().min(1).max(1024),
    scopeKey: z.string().max(1024),
  })
  .strict();
const location = z
  .object({
    sourceId: source.nullable(),
    locationId: z.string().uuid().nullable(),
    name: text,
    snapshottedAt: time,
    address: z
      .object({
        address1: text.nullable(),
        address2: text.nullable(),
        city: text.nullable(),
        provinceCode: text.nullable(),
        countryCode: text.nullable(),
        zip: text.nullable(),
      })
      .strict(),
  })
  .strict()
  .nullable();
const line = {
  sourceId: source,
  sourceSku: source.nullable(),
  skuId: z.string().uuid().nullable(),
  unit: z.string().min(1).max(64),
};

/** Validates canonical transfer evidence with explicit unknown location and SKU relationships. */
export const transferDataSchema = z
  .object({
    type: z.literal('inventory_transfer'),
    name: text,
    status: z.enum([
      'draft',
      'ready',
      'in_progress',
      'received',
      'cancelled',
      'unknown',
    ]),
    createdAt: time.nullable(),
    origin: location,
    destination: location,
    requestedQuantity: quantity,
    receivedQuantity: quantity,
    lines: z
      .array(
        z
          .object({
            ...line,
            title: text.nullable(),
            requested: quantity,
            picked: quantity,
            ready: quantity,
            shipped: quantity,
          })
          .strict(),
      )
      .max(5000)
      .refine(
        (values) => uniqueSources(values.map((value) => value.sourceId)),
        'Duplicate line identity',
      )
      .nullable(),
    shipmentSources: z
      .array(source)
      .max(5000)
      .refine(uniqueSources, 'Duplicate shipment identity')
      .nullable(),
  })
  .strict();

/** Validates source receiving categories without deriving a physical stock movement. */
export const shipmentDataSchema = z
  .object({
    type: z.literal('inventory_shipment'),
    name: text,
    status: z.enum([
      'draft',
      'in_transit',
      'partially_received',
      'received',
      'unknown',
    ]),
    createdAt: time.nullable(),
    shippedAt: time.nullable(),
    receivedAt: time.nullable(),
    expectedArrivalAt: time.nullable(),
    quantity,
    receivedQuantity: quantity,
    acceptedQuantity: quantity,
    rejectedQuantity: quantity,
    lines: z
      .array(
        z
          .object({
            ...line,
            quantity,
            accepted: quantity,
            rejected: quantity,
            unreceived: quantity,
          })
          .strict(),
      )
      .max(5000)
      .refine(
        (values) => uniqueSources(values.map((value) => value.sourceId)),
        'Duplicate line identity',
      )
      .nullable(),
    tracking: z
      .object({
        carrier: text.nullable(),
        number: text.nullable(),
        url: z
          .string()
          .max(2048)
          .url()
          .regex(/^https?:\/\//i)
          .nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
