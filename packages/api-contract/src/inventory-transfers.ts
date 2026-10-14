import { z } from 'zod';

import {
  collectionTimeZoneParameter,
  collectionWhereParameter,
} from './collections.js';

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
const transferDataSchema = z
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
const shipmentDataSchema = z
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

export const transferQuerySchema = z
  .object({
    kind: z
      .enum(['inventory_transfer', 'inventory_shipment'])
      .default('inventory_transfer'),
    q: z.string().trim().max(120).default(''),
    connectionId: z.string().uuid().optional(),
    skuId: z.string().uuid().optional(),
    locationId: z.string().uuid().optional(),
    sort: z
      .enum(['requested', 'name', 'updated'])
      .default('requested')
      .describe(
        '`requested`: when the source created the record. `updated`: when the source last changed it. Records without a value come last in both directions.',
      ),
    direction: z.enum(['asc', 'desc']).default('desc'),
    limit: z.coerce.number().int().min(1).max(50).default(50),
    count: z
      .literal('exact')
      .optional()
      .describe(
        'Request the exact number of matches. Without this option, totalCount is null.',
      ),
    where: collectionWhereParameter.optional(),
    timeZone: collectionTimeZoneParameter,
    cursor: z.string().min(1).max(1024).optional(),
  })
  .strict();

const transferFactsSchema = z.object({
  requested: z.string().nullable(),
  received: z.string().nullable(),
  shipped: z.string().nullable(),
  unreceived: z.string().nullable(),
  rejected: z.string().nullable(),
  expectedArrivalAt: time.nullable(),
  origin: z.string().nullable(),
  destination: z.string().nullable(),
  complete: z.boolean(),
  consistent: z.boolean(),
});

const transferSummarySchema = z.object({
  id: z.string().uuid(),
  connectionId: z.string().uuid(),
  label: z.string(),
  kind: z.enum(['inventory_transfer', 'inventory_shipment']),
  name: z.string(),
  status: z.string(),
  snapshotId: z.string().uuid(),
  observedAt: time,
  facts: transferFactsSchema,
  evidence: z.enum(['fresh', 'stale', 'incomplete', 'unavailable', 'removed']),
  signals: z.array(
    z.enum([
      'inconsistent_quantities',
      'rejected',
      'terminal_unreceived',
      'receipt_late',
    ]),
  ),
});

export const transferListSchema = z.object({
  items: z.array(transferSummarySchema),
  totalCount: z.number().int().nonnegative().nullable(),
  nextCursor: z.string().nullable(),
  asOf: time,
});

export const transferDetailSchema = z.object({
  record: transferSummarySchema,
  provenance: z.object({
    observationId: z.string().uuid(),
    sourceRevision: z.string().nullable(),
    sourceUpdatedAt: time.nullable(),
  }),
  deleted: z.boolean(),
  data: z.union([transferDataSchema, shipmentDataSchema]).nullable(),
  source: source.nullable(),
  shipments: z.array(transferSummarySchema),
  transfers: z.array(transferSummarySchema),
  history: z.array(
    z.object({
      name: z.string(),
      snapshotId: z.string().uuid(),
      observedAt: time,
      deleted: z.boolean(),
      status: z.string(),
      receivedQuantity: z.string().nullable(),
      origin: location,
      destination: location,
    }),
  ),
  purchaseOrders: z.array(
    z.object({ id: z.string().uuid(), label: z.string(), status: z.string() }),
  ),
  hidden: z.array(z.literal('purchaseOrders')),
  relatedTruncated: z.boolean(),
  asOf: time,
});

export type TransferSummary = z.infer<typeof transferSummarySchema>;

export type TransferDetail = z.infer<typeof transferDetailSchema>;
