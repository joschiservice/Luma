import { z } from 'zod';

import {
  approvalBehaviorSchema,
  workflowActivationSchema,
  workflowReadinessSchema,
} from './workflows.js';

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

/** The most recent run for one stock position. */
export const replenishmentRunSummarySchema = z.object({
  runId: z.string().uuid(),
  state: z.string().nullable(),
  summary: z.string(),
  at: z.string().datetime(),
  /** Set once the run recorded a verification against this purchase order. */
  purchaseOrderId: z.string().uuid().nullable(),
});

/** Reads one page of stock choices. Keep the same filters when continuing a cursor. */
export const replenishmentPositionQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    cursor: z
      .string()
      .regex(/^[a-f0-9-]{36}:[a-f0-9-]{36}$/i)
      .optional(),
    positionId: z.string().uuid().optional(),
    connectionId: z.string().uuid().optional(),
  })
  .strict();

const replenishmentStockSchema = z.object({
  positionId: z.string().uuid(),
  connectionId: z.string().uuid(),
  sku: z.string(),
  unit: z.string(),
  available: z.number().nullable(),
  observedAt: z.string(),
});

export const replenishmentSetupSchema = z.object({
  available: z.boolean(),
  canManage: z.boolean(),
  positions: z.array(replenishmentStockSchema).max(50),
  nextCursor: z.string().nullable(),
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
      stock: replenishmentStockSchema.nullable(),
      /** Whether this rule's stock can support a decision now. */
      status: z.object({
        state: z.enum(['ready', 'blocked', 'revoked']),
        code: z.string(),
        message: z.string(),
      }),
      /** The run whose proposal waits for approval in Needs you. */
      waitingRunId: z.string().uuid().nullable(),
      latestRun: replenishmentRunSummarySchema.nullable(),
    }),
  ),
});

const quantity = z.number().int().min(0).max(1000000);

/**
 * Up to 25 stock positions with their own quantity limits, all ordered from one supplier.
 * Each position appears once.
 */
export const replenishmentPreviewRequestSchema = z
  .object({
    supplierId: z.string().uuid(),
    items: z
      .array(
        z
          .object({
            positionId: z.string().uuid(),
            connectionId: z.string().uuid(),
            minimum: quantity.max(999999),
            target: quantity,
            approvalQuantity: quantity,
          })
          .strict(),
      )
      .min(1)
      .max(25)
      .refine(
        (items) =>
          new Set(items.map((item) => item.positionId)).size === items.length,
        { message: 'Choose each stock position once.' },
      ),
  })
  .strict();

export const replenishmentPreviewSchema = z.object({
  approval: approvalBehaviorSchema,
  supplier: z.object({ id: z.string().uuid(), name: z.string() }),
  items: z.array(
    z.object({
      positionId: z.string().uuid(),
      connectionId: z.string().uuid(),
      sku: z.string().nullable(),
      unit: z.string().nullable(),
      available: z.number().nullable(),
      observedAt: z.string().nullable(),
      /** `ready` activates; `covered` keeps the existing rule; others can't activate. */
      outcome: z.enum(['ready', 'covered', 'unavailable', 'invalid']),
      message: z.string(),
      existingRule: z
        .object({
          id: z.string().uuid(),
          supplier: z.string(),
          minimum: z.number(),
          target: z.number(),
        })
        .nullable(),
      belowMinimum: z.boolean(),
      proposedQuantity: z.number().nullable(),
      risk: z.enum(['medium', 'high']).nullable(),
    }),
  ),
});

/** Up to 25 reviewed rules. Each has its own ID; resend the same items to retry. */
export const replenishmentBatchRequestSchema = z
  .object({
    items: z
      .array(replenishmentRuleSchema)
      .min(1)
      .max(25)
      .refine(
        (items) =>
          new Set(items.map((item) => item.positionId)).size === items.length &&
          new Set(items.map((item) => item.id)).size === items.length,
        { message: 'Each stock position and request ID can appear once.' },
      ),
  })
  .strict();

export const replenishmentBatchResultSchema = z.object({
  results: z.array(
    z.object({
      id: z.string().uuid(),
      positionId: z.string().uuid(),
      status: z.enum(['activated', 'failed', 'uncertain']),
      code: z.enum(['activated', 'covered', 'rejected', 'uncertain']),
      message: z.string(),
      activation: workflowActivationSchema.nullable(),
    }),
  ),
});

/** How a workflow covers one record, with readiness scoped to that record. */
export const workflowCoverageSchema = z.object({
  items: z.array(
    z.object({
      definitionId: z.string(),
      name: z.string(),
      purpose: z.string(),
      canManage: z.boolean(),
      readiness: workflowReadinessSchema,
      rule: z
        .object({
          id: z.string().uuid(),
          supplier: z.string(),
          minimum: z.number(),
          target: z.number(),
          approvalQuantity: z.number(),
          active: z.boolean(),
        })
        .nullable(),
      stock: z
        .object({
          sku: z.string(),
          unit: z.string(),
          available: z.number().nullable(),
          observedAt: z.string(),
        })
        .nullable(),
      latestRun: replenishmentRunSummarySchema.nullable(),
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

export type ReplenishmentPreviewRequest = z.infer<
  typeof replenishmentPreviewRequestSchema
>;

export type ReplenishmentPreview = z.infer<typeof replenishmentPreviewSchema>;

export type ReplenishmentBatchResult = z.infer<
  typeof replenishmentBatchResultSchema
>;

export type WorkflowCoverage = z.infer<typeof workflowCoverageSchema>;

export type ReplenishmentPositionQuery = z.infer<
  typeof replenishmentPositionQuerySchema
>;
