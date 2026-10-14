import { z } from 'zod';

import {
  collectionGroupKeyParameter,
  collectionGroupLimitParameter,
  collectionGroupParameter,
  collectionGroupSchema,
  collectionTimeZoneParameter,
  collectionWhereParameter,
} from './collections.js';

const stockSourceSchema = z.object({
  bundleContext: z
    .object({
      observedAt: z.string().datetime({ offset: true }),
      componentCount: z.number().int().nonnegative().nullable(),
    })
    .nullable()
    .optional()
    .describe(
      'Catalog context of a known bundle parent. Its timestamp is independent of the stock read and does not establish physical component stock.',
    ),
  connectionId: z.string().uuid(),
  label: z.string(),
  status: z.string(),
  externalSku: z.string().nullable(),
  externalLocation: z.string().nullable(),
  mappingMethod: z.string().nullable(),
  onHand: z.string().nullable(),
  reserved: z.string().nullable(),
  available: z.string().nullable(),
  incoming: z.string().nullable(),
  committed: z.string().nullable().optional(),
  damaged: z.string().nullable().optional(),
  qualityControl: z.string().nullable().optional(),
  safetyStock: z.string().nullable().optional(),
  locationActive: z.boolean().nullable().optional(),
  itemActive: z.boolean().nullable().optional(),
  tracked: z.boolean().nullable().optional(),
  inventorySemantics: z.literal('shopify/1').nullable().optional(),
  writeAttribution: z
    .object({
      evidenceId: z.string().uuid(),
      adjustmentId: z.string(),
      referenceDocumentUri: z.string(),
      available: z.string(),
      quantityMatches: z.boolean().nullable(),
    })
    .nullable()
    .optional(),
  availabilityBasis: z.enum(['provider_reported', 'derived', 'unknown']),
  observedAt: z.string().datetime({ offset: true }),
  sourceUpdatedAt: z.string().datetime({ offset: true }).nullable(),
  deleted: z.boolean(),
});

export const stockPositionSchema = z.object({
  id: z.string().uuid(),
  skuId: z.string().uuid(),
  sku: z.string(),
  skuKey: z.string(),
  locationId: z.string().uuid(),
  location: z.string(),
  unit: z.string(),
  sources: z.array(stockSourceSchema),
  differences: z.array(z.enum(['onHand', 'reserved', 'available'])),
  /**
   * Set while Luma waits for provider sync to close an available-stock gap: first seen at
   * `since`; raised as an issue if the gap is still open at `until`.
   */
  sync: z
    .object({
      since: z.string().datetime({ offset: true }),
      until: z.string().datetime({ offset: true }),
    })
    .nullable(),
});

const inventorySortSchema = z.enum([
  'sku',
  'location',
  'available',
  'onHand',
  'incoming',
  'lastRead',
]);

export const inventoryQuerySchema = z
  .object({
    q: z.string().trim().max(120).default(''),
    view: z.enum(['all', 'differs', 'unknown']).default('all'),
    skuId: z.string().uuid().optional(),
    locationId: z.string().uuid().optional(),
    connectionId: z.string().uuid().optional(),
    sort: inventorySortSchema
      .default('sku')
      .describe(
        'Quantities sort by the lowest value any source reports; sources that report none are ignored. `lastRead` is the most recent read of any source. Positions without a value come last in both directions. Ties continue by SKU, location and position ID.',
      ),
    direction: z.enum(['asc', 'desc']).default('asc'),
    limit: z.coerce.number().int().min(1).max(50).default(50),
    count: z
      .literal('exact')
      .optional()
      .describe(
        'Request the exact number of matches. Without this option, totalCount is null.',
      ),
    where: collectionWhereParameter.optional(),
    group: collectionGroupParameter.optional(),
    groupKey: collectionGroupKeyParameter.optional(),
    groupLimit: collectionGroupLimitParameter,
    timeZone: collectionTimeZoneParameter,
    cursor: z.string().min(1).max(1024).optional(),
  })
  .strict();

export const inventoryListSchema = z.object({
  items: z.array(stockPositionSchema),
  totalCount: z.number().int().nonnegative().nullable(),
  nextCursor: z.string().nullable(),
  groups: z
    .array(collectionGroupSchema)
    .optional()
    .describe(
      'With `group`: each group in display order with its exact count and first positions, whose items are in `items`. A position counts in the group of each of its sources. With `groupKey`: the one group, with this page of its positions.',
    ),
  groupsTruncated: z
    .boolean()
    .optional()
    .describe(
      'More than 50 groups match; narrow the conditions to see the rest.',
    ),
  asOf: z.string().datetime({ offset: true }),
});

export const inventoryDetailSchema = z.object({
  position: stockPositionSchema,
  history: z.object({
    entries: z.array(
      stockSourceSchema.extend({ id: z.string().uuid(), current: z.boolean() }),
    ),
    truncated: z.boolean(),
  }),
  orders: z.array(
    z.object({
      id: z.string().uuid(),
      label: z.string(),
      status: z.string(),
      connectionId: z.string().uuid(),
      quantity: z.string(),
      unit: z.string(),
    }),
  ),
  purchaseOrders: z.array(
    z.object({
      id: z.string().uuid(),
      label: z.string(),
      status: z.string(),
      quantity: z.number(),
      unit: z.string(),
    }),
  ),
  issues: z.array(
    z.object({ id: z.string().uuid(), label: z.string(), state: z.string() }),
  ),
  relatedTruncated: z.boolean(),
  asOf: z.string().datetime({ offset: true }),
});

export type StockSource = z.infer<typeof stockSourceSchema>;

export type StockPosition = z.infer<typeof stockPositionSchema>;

export type InventoryList = z.infer<typeof inventoryListSchema>;

export type InventoryDetail = z.infer<typeof inventoryDetailSchema>;
