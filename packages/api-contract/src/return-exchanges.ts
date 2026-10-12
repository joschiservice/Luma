import { z } from 'zod';

const ref = z
  .object({
    externalId: z.string().min(1).max(200),
    scopeKey: z.string().max(1024),
  })
  .strict();
const quantity = z.number().int().min(1).max(1_000_000);
const amount = z.string().regex(/^\d{1,14}(?:\.\d{1,6})?$/);
const replacement = z
  .object({
    skuId: z.string().uuid(),
    mappingIds: z.array(z.string().uuid()).min(2).max(10),
    inventoryItem: ref,
    variantId: z.string().min(1).max(200),
    wawiConnectionId: z.string().uuid(),
    item: ref,
    quantity,
  })
  .strict();
const financial = z
  .object({
    kind: z.enum(['even', 'charge', 'refund']),
    amount,
    currency: z.string().regex(/^[A-Z]{3}$/),
    transactions: z
      .array(z.object({ parentId: z.string().min(1), amount }).strict())
      .max(20),
    priorSuccessfulTransactionIds: z.array(z.string().min(1)).max(100),
  })
  .strict();
const marker = z.string().regex(/^luma-ex:[0-9a-f-]{36}:[0-9a-f-]{36}$/);

const exchangePlanSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('request'),
      marker,
      order: ref,
      lines: z
        .array(
          z
            .object({
              orderLineId: z.string().uuid(),
              source: ref,
              quantity,
              reason: z.string().min(1).max(100),
            })
            .strict(),
        )
        .min(1)
        .max(20),
      replacement,
    })
    .strict(),
  z
    .object({
      kind: z.literal('process'),
      marker,
      order: ref,
      returnId: z.string().min(1),
      returnLines: z
        .array(z.object({ id: z.string().min(1), quantity }).strict())
        .min(1)
        .max(20),
      exchangeLine: z.object({ id: z.string().min(1), quantity }).strict(),
      replacement,
      financial,
    })
    .strict(),
  z
    .object({
      kind: z.literal('cancel'),
      marker,
      order: ref,
      returnId: z.string().min(1),
      lines: z
        .array(
          z
            .object({
              orderLineId: z.string().uuid(),
              source: ref,
              quantity,
              reason: z.string().min(1).max(100),
            })
            .strict(),
        )
        .min(1)
        .max(20),
      replacement,
    })
    .strict(),
  z
    .object({
      kind: z.literal('release'),
      marker,
      returnLines: z
        .array(z.object({ id: z.string().min(1), quantity }).strict())
        .min(1)
        .max(20),
      exchangeLine: z.object({ id: z.string().min(1), quantity }).strict(),
      replacement,
      order: ref,
      returnId: z.string().min(1),
      fulfillmentOrderId: z.string().min(1),
      holdId: z.string().min(1),
      financial,
    })
    .strict(),
]);

/** Validates independently observed intent, fulfillment and payment outcomes. */
const exchangeProofSchema = z
  .object({
    outcome: z.enum(['passed', 'failed', 'inconclusive']),
    observedAt: z.string().datetime(),
    evidenceRefs: z.array(z.string().uuid()).min(1),
    returnId: z.string().nullable(),
    processLines: z
      .object({
        returnLines: z
          .array(z.object({ id: z.string().min(1), quantity }).strict())
          .min(1)
          .max(20),
        exchangeLine: z.object({ id: z.string().min(1), quantity }).strict(),
      })
      .strict()
      .nullable(),
    fulfillmentOrderId: z.string().nullable(),
    paymentHoldId: z.string().nullable(),
    fulfillmentReady: z.boolean(),
    payment: z.enum([
      'not_required',
      'pending',
      'failed',
      'partial',
      'paid',
      'unknown',
    ]),
    financial: financial.nullable(),
  })
  .strict();

/** One exact approved provider step and its independent source proof. */
export const exchangeStepSchema = z.object({
  id: z.string().uuid(),
  actionId: z.string().uuid(),
  operationId: z.string().uuid(),
  tenantId: z.string().uuid(),
  caseId: z.string().uuid(),
  connectionId: z.string().uuid(),
  plan: exchangePlanSchema,
  caseDigest: z.string(),
  requestDigest: z.string(),
  quote: z.object({
    observedAt: z.string(),
    evidenceRefs: z.array(z.string()),
  }),
  requestedBy: z.string(),
  requestedAt: z.string(),
  expiresAt: z.string(),
  decisionId: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
  state: z.enum([
    'approval_required',
    'approved',
    'rejected',
    'expired',
    'sending',
    'uncertain',
    'verified',
    'failed',
    'not_executed',
  ]),
  sent: z.boolean(),
  proof: exchangeProofSchema.nullable(),
  failure: z.string().nullable(),
  updatedAt: z.string(),
  observeOnly: z.boolean(),
  canApprove: z.boolean(),
  canSend: z.boolean(),
  canCheck: z.boolean(),
});

/** Final independently observed consistency across the store and physical stock owner. */
export const exchangeConsistencySchema = z
  .object({
    state: z.enum(['verified', 'unresolved']),
    checkedAt: z.string().datetime(),
    ownerId: z.string(),
    caseRevision: z.number().int().positive(),
    evidenceRefs: z.array(z.string()).max(1000),
    replacementOrder: ref.nullable(),
    replacementTotal: z
      .object({ amount, currency: z.string().regex(/^[A-Z]{3}$/) })
      .strict()
      .nullable(),
    checks: z
      .array(
        z
          .object({
            id: z.enum([
              'receipt',
              'inspection',
              'stock',
              'replacement',
              'reservation',
              'payment',
              'fulfillment',
            ]),
            verified: z.boolean(),
            reason: z.string().min(1).max(100),
          })
          .strict(),
      )
      .length(7),
  })
  .strict();

/** One operation retains all explicit choices and financial/fulfillment waits. */
export const returnExchangeSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  caseId: z.string().uuid(),
  connectionId: z.string().uuid(),
  startedBy: z.string(),
  startedAt: z.string(),
  ownerId: z.string(),
  revision: z.number().int(),
  choice: z
    .object({
      kind: z.enum(['wait', 'different_item', 'refund']),
      by: z.string(),
      at: z.string(),
    })
    .nullable(),
  currentAttemptId: z.string().uuid(),
  replacementName: z.string(),
  request: exchangePlanSchema,
  availability: z
    .object({
      available: z.boolean().nullable(),
      observedAt: z.string(),
      evidenceRefs: z.array(z.string()),
    })
    .nullable(),
  processingStarted: z.boolean(),
  completion: exchangeConsistencySchema.optional(),
  updatedAt: z.string(),
});

/** Choices show source-reported available units, never a reservation claim. */
const exchangeChoiceSchema = replacement.omit({ quantity: true }).extend({
  id: z.string(),
  label: z.string(),
  available: z.number().nullable(),
});

export const returnExchangesSchema = z.object({
  operation: returnExchangeSchema.nullable(),
  steps: z.array(exchangeStepSchema),
  choices: z.array(exchangeChoiceSchema),
  choiceStatus: z.enum([
    'unavailable',
    'not_configured',
    'ready',
    'restricted',
  ]),
  available: z.boolean(),
  asOf: z.string(),
});

export const exchangeRequestSchema = z
  .object({
    id: z.string().uuid(),
    operationId: z.string().uuid(),
    kind: z.enum(['request', 'process', 'cancel', 'release']),
    replacementId: z.string().optional(),
    quantity: quantity.optional(),
  })
  .strict();

export const exchangeChoiceInputSchema = z
  .object({
    revision: z.number().int().positive(),
    kind: z.enum(['wait', 'different_item', 'refund']),
  })
  .strict();

export type ReturnExchangesView = z.infer<typeof returnExchangesSchema>;
