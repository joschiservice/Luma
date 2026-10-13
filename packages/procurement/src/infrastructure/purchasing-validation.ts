import { z } from 'zod';

import { incomingStockItemSchema } from './incoming-validation.js';
import { purchaseOrderInputSchema } from './validation.js';

export const purchasingSettingsSchema = z
  .object({
    demandPeriodDays: z.number().int().min(7).max(180),
    safetyDays: z.number().int().min(0).max(90),
    locationIds: z.array(z.string().uuid()).max(100),
    revision: z.number().int().min(0),
  })
  .strict();

const stockSchema = z.object({
  positionId: z.string().uuid(),
  skuId: z.string().uuid(),
  sku: z.string(),
  locationId: z.string().uuid(),
  location: z.string(),
  connectionId: z.string().uuid(),
  unit: z.string(),
  available: z.number().nullable(),
  reserved: z.number().nullable(),
  observedAt: z.string().datetime(),
  observationId: z.string().uuid(),
  complete: z.boolean(),
  authoritative: z.boolean(),
});

export const purchasingRecommendationSchema = z.object({
  key: z.string(),
  supplierId: z.string().uuid(),
  supplierName: z.string(),
  skuId: z.string().uuid(),
  sku: z.string(),
  termsRevision: z.number().int(),
  termsObservedAt: z.string().datetime().nullable(),
  packSize: z.number().nullable(),
  minimumQuantity: z.number().nullable(),
  leadTimeDays: z.number().nullable(),
  supplierArticleNumber: z.string().nullable(),
  unitPrice: z.object({ amount: z.string(), currency: z.string() }).nullable(),
  orderMinimumValue: z
    .object({ amount: z.string(), currency: z.string() })
    .nullable(),
  stocks: z.array(stockSchema),
  incoming: z.array(incomingStockItemSchema),
  incomingQuantity: z.number().nullable(),
  demand: z.object({
    daily: z.number().nullable(),
    units: z.number().nullable(),
    periodDays: z.number(),
    observedAt: z.string().datetime().nullable(),
    evidenceRefs: z.array(z.string()),
    complete: z.boolean(),
  }),
  existingOrders: z.array(
    z.object({
      id: z.string().uuid(),
      reference: z.string(),
      quantity: z.number(),
      status: z.enum(['draft', 'open']),
    }),
  ),
  rule: z.object({ minimum: z.number(), target: z.number() }).nullable(),
  available: z.number().nullable(),
  daysOfCover: z.number().nullable(),
  rawQuantity: z.number().nullable(),
  quantity: z.number().nullable(),
  orderBy: z.string().datetime().nullable(),
  missing: z.array(z.string()),
});

export const purchasingPlanInputSchema = z
  .object({
    id: z.string().uuid(),
    supplierId: z.string().uuid(),
    reference: z.string().trim().min(1).max(200),
    lines: z
      .array(
        z.object({
          skuId: z.string().uuid(),
          locationId: z.string().uuid(),
          quantity: z.number().int().min(1).max(1_000_000),
          termsRevision: z.number().int().min(1),
        }),
      )
      .min(1)
      .max(100),
    reason: z.string().trim().max(1000),
    sourceOrderId: z.string().uuid().optional(),
    attentionKey: z.string().max(300).optional(),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.lines.map((l) => `${l.skuId}:${l.locationId}`)).size ===
      v.lines.length,
    'Each product and location may appear once.',
  );

export const purchasingPlanSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  supplierId: z.string().uuid(),
  requestedBy: z.string(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  request: purchasingPlanInputSchema,
  order: purchaseOrderInputSchema,
  suggestions: z.array(
    z.object({
      skuId: z.string().uuid(),
      locationId: z.string().uuid(),
      suggested: z.number().nullable(),
      chosen: z.number(),
      sourceConnectionIds: z.array(z.string().uuid()).optional(),
      target: z.number().nullable().optional(),
      evidenceRefs: z.array(z.string()),
    }),
  ),
  decisionId: z.string().uuid().nullable(),
  state: z.enum([
    'approval_required',
    'approved',
    'rejected',
    'withheld',
    'uncertain',
    'verified',
    'failed',
    'expired',
  ]),
  failure: z.string().nullable(),
  actionId: z.string().uuid(),
  canApprove: z.boolean().optional(),
  canExecute: z.boolean().optional(),
});
