import { z } from 'zod';

const external = z
  .object({
    externalId: z.string().min(1).max(1024),
    scopeKey: z.string().max(1024),
  })
  .strict();
const text = z.string().min(1).max(512);
const quantity = z.string().regex(/^\d{1,14}(\.\d{1,6})?$/);
const time = z.string().datetime({ offset: true });
const uniqueSources = (values: { externalId: string; scopeKey: string }[]) =>
  new Set(
    values.map((value) => JSON.stringify([value.externalId, value.scopeKey])),
  ).size === values.length;
const location = z
  .object({
    id: external.nullable(),
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

/** Validates complete or explicitly unavailable transfer collections without deriving stock. */
export const transferSnapshotSchema = z
  .object({
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
            id: external,
            sku: external.nullable(),
            title: text.nullable(),
            unit: z.string().min(1).max(64),
            requested: quantity,
            picked: quantity,
            ready: quantity,
            shipped: quantity,
          })
          .strict(),
      )
      .max(5000)
      .refine(
        (values) => uniqueSources(values.map((value) => value.id)),
        'Duplicate line identity',
      )
      .nullable(),
    shipments: z
      .array(external)
      .max(5000)
      .refine(uniqueSources, 'Duplicate shipment identity')
      .nullable(),
  })
  .strict();

/** Validates receiving facts while preserving cancellation-inclusive source totals. */
export const shipmentSnapshotSchema = z
  .object({
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
            id: external,
            sku: external.nullable(),
            unit: z.string().min(1).max(64),
            quantity,
            accepted: quantity,
            rejected: quantity,
            unreceived: quantity,
          })
          .strict(),
      )
      .max(5000)
      .refine(
        (values) => uniqueSources(values.map((value) => value.id)),
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
