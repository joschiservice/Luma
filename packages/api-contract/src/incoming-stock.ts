import { z } from 'zod';

export const incomingStockItemSchema = z.object({
  key: z.string(),
  source: z.enum(['purchase_order', 'transfer', 'ledger']),
  skuId: z.string().uuid(),
  locationId: z.string().uuid().nullable(),
  location: z.string().nullable(),
  quantity: z.number().finite().nonnegative(),
  unit: z.string(),
  expectedDate: z.string().nullable(),
  dateStatus: z.enum(['confirmed', 'requested', 'overdue', 'unknown']),
  orderId: z.string().uuid().nullable(),
  orderReference: z.string().nullable(),
  supplierId: z.string().uuid().nullable(),
  supplierName: z.string().nullable(),
  transferId: z.string().uuid().nullable(),
  observedAt: z.string().datetime(),
  freshness: z.enum(['fresh', 'stale']),
  evidenceRefs: z.array(z.string()),
});

export const incomingStockSchema = z.object({
  enabled: z.boolean(),
  items: z.array(incomingStockItemSchema),
  truncated: z.boolean(),
  supplierOrdersUnavailable: z.boolean(),
  unavailableNativeIncoming: z.boolean(),
  asOf: z.string().datetime(),
});

export const incomingStockQuerySchema = z
  .object({
    skuIds: z.array(z.string().uuid()).min(1).max(250),
    locationId: z.string().uuid().optional(),
  })
  .strict();

export type IncomingStock = z.infer<typeof incomingStockSchema>;
