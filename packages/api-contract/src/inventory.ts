import { z } from 'zod';

export const stockSourceSchema = z.object({
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
});

export const inventoryQuerySchema = z
  .object({
    q: z.string().trim().max(120).default(''),
    view: z.enum(['all', 'differs', 'unknown']).default('all'),
    skuId: z.string().uuid().optional(),
    locationId: z.string().uuid().optional(),
    connectionId: z.string().uuid().optional(),
    cursor: z.string().min(1).max(1024).optional(),
  })
  .strict();

export const inventoryListSchema = z.object({
  items: z.array(stockPositionSchema),
  nextCursor: z.string().nullable(),
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
