import { z } from 'zod';

export const purchasingIgnoreSchema = z
  .object({
    id: z.string().uuid(),
    supplierId: z.string().uuid(),
    skuId: z.string().uuid(),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();

const purchasingOutcomeSchema = z.object({
  id: z.string().uuid(),
  supplierId: z.string().uuid(),
  supplierName: z.string(),
  skuId: z.string().uuid(),
  sku: z.string(),
  locationId: z.string().uuid(),
  suggested: z.number().nullable(),
  chosen: z.number().nullable(),
  decision: z.enum(['followed', 'changed', 'ignored']),
  decidedAt: z.string().datetime(),
  orderId: z.string().uuid().nullable(),
  state: z.enum(['unknown', 'stockout_observed', 'available_through_receipt']),
  stockoutAt: z.string().datetime().nullable(),
  observedStockoutMinutes: z.number().nullable(),
  aboveTarget: z.number().nullable(),
  receiptAt: z.string().datetime().nullable(),
  complete: z.boolean(),
  evidenceRefs: z.array(z.string()),
  reason: z.string().nullable(),
});

export const purchasingOutcomeListSchema = z.object({
  enabled: z.boolean(),
  items: z.array(purchasingOutcomeSchema),
  summary: z.object({
    verifiedAvailable: z.number().int(),
    stockouts: z.number().int(),
    unknown: z.number().int(),
  }),
  truncated: z.boolean(),
  asOf: z.string().datetime(),
});

export type PurchasingOutcome = z.infer<typeof purchasingOutcomeSchema>;
