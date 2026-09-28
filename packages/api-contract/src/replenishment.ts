import { z } from 'zod';

/** Review stock scope and quantity limits before activating replenishment. */
export const replenishmentRuleSchema = z
  .object({
    id: z.string().uuid(),
    positionId: z.string().uuid(),
    connectionId: z.string().uuid(),
    supplierId: z.string().uuid(),
    minimum: z.number().int().min(0).max(999999),
    target: z.number().int().positive().max(1000000),
    approvalQuantity: z.number().int().min(0).max(1000000),
    reviewedDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .refine((rule) => rule.target > rule.minimum, {
    message: 'Target stock must exceed the minimum.',
    path: ['target'],
  });

export const replenishmentSetupSchema = z.object({
  available: z.boolean(),
  canManage: z.boolean(),
  positions: z.array(
    z.object({
      positionId: z.string().uuid(),
      connectionId: z.string().uuid(),
      sku: z.string(),
      unit: z.string(),
      available: z.number().nullable(),
      observedAt: z.string(),
    }),
  ),
  suppliers: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
  rules: z.array(
    z.object({
      id: z.string().uuid(),
      positionId: z.string().uuid(),
      connectionId: z.string().uuid(),
      supplierId: z.string().uuid(),
      minimum: z.number(),
      target: z.number(),
      approvalQuantity: z.number(),
      active: z.boolean(),
      principalId: z.string(),
      sku: z.string(),
      supplier: z.string(),
    }),
  ),
});

export const replenishmentReviewSchema = z.object({
  runId: z.string().uuid(),
  supplierId: z.string().uuid(),
  stock: z.object({
    available: z.number().nullable(),
    unit: z.string().nullable(),
    minimum: z.number(),
    target: z.number(),
    checkedAt: z.string().datetime().nullable(),
  }),
  decision: z.object({ id: z.string(), outcome: z.string() }).nullable(),
  purchaseOrder: z
    .object({
      id: z.string().uuid(),
      reference: z.string(),
      status: z.string(),
    })
    .nullable(),
  verification: z.object({
    state: z.enum(['verified', 'failed', 'inconclusive', 'not_verified']),
    recordedAt: z.string().datetime().nullable(),
  }),
  proposalId: z.string().uuid().nullable(),
  decisionId: z.string().nullable(),
  quantity: z.number().nullable(),
  sku: z.string(),
  supplier: z.string(),
  state: z.string(),
  canRespond: z.boolean(),
});

export type ReplenishmentRuleInput = z.infer<typeof replenishmentRuleSchema>;

export type ReplenishmentSetup = z.infer<typeof replenishmentSetupSchema>;
