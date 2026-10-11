import { z } from 'zod';

import { returnStatusSchema } from './returns.js';

const returnCaseReasonSchema = z.enum([
  'damaged',
  'defective',
  'wrong_item',
  'not_as_described',
  'size_or_fit',
  'no_longer_needed',
  'other',
]);

const resolutionKindSchema = z.enum([
  'refund',
  'exchange',
  'store_credit',
  'rejection',
]);

const returnCaseStageSchema = z.enum([
  'awaiting_receipt',
  'awaiting_inspection',
  'awaiting_proposal',
  'proposed',
  'cancelled',
]);

const returnCreationStateSchema = z.enum([
  'approval_required',
  'approved',
  'rejected',
  'expired',
  'sending',
  'uncertain',
  'created',
  'failed',
  'not_executed',
]);

const returnCreationFailureSchema = z.enum([
  'withheld',
  'not_accepted',
  'mismatch',
  'changed',
  'not_sent',
]);

const returnCreationBlockerSchema = z.enum([
  'cancelled',
  'execution_disabled',
  'unsupported',
  'reconnect',
  'connection_inactive',
  'unmapped',
  'in_progress',
  'created',
]);

const units = z.number().int().min(0).max(1_000_000);

const note = z.string().trim().max(2000);

const decisionEvidenceSchema = z
  .object({
    note: note.nullable(),
    link: z
      .string()
      .trim()
      .url()
      .max(2000)
      .refine((value) => /^https?:\/\//i.test(value), 'Use an http(s) link.')
      .nullable(),
  })
  .strict();

const command = {
  commandId: z.string().uuid(),
  expectedRevision: z.number().int().min(1),
};

const sourceRef = z
  .object({
    externalId: z.string().min(1).max(200),
    scopeKey: z.string().max(1024),
  })
  .strict();

const personSchema = z.object({ id: z.string(), name: z.string().nullable() });

export const openReturnCaseSchema = z
  .object({
    id: z.string().uuid(),
    connectionId: z.string().uuid(),
    sourceReturnId: z.string().uuid().nullable(),
    lines: z
      .array(
        z
          .object({
            orderLineId: z.string().uuid(),
            quantity: units.min(1),
            reason: returnCaseReasonSchema,
            note: note.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

export const assignReturnCaseSchema = z
  .object({ ...command, assigneeId: z.string().uuid().nullable() })
  .strict();

export const recordReceiptSchema = z
  .object({
    ...command,
    lines: z
      .array(
        z.object({ orderLineId: z.string().uuid(), received: units }).strict(),
      )
      .min(1)
      .max(200),
    evidence: decisionEvidenceSchema,
  })
  .strict();

export const recordInspectionSchema = z
  .object({
    ...command,
    lines: z
      .array(
        z
          .object({
            orderLineId: z.string().uuid(),
            resellable: units,
            damaged: units,
          })
          .strict(),
      )
      .min(1)
      .max(200),
    evidence: decisionEvidenceSchema,
  })
  .strict();

export const proposeResolutionSchema = z
  .object({
    ...command,
    kind: resolutionKindSchema,
    lines: z
      .array(
        z.object({ orderLineId: z.string().uuid(), restock: units }).strict(),
      )
      .min(1)
      .max(200),
    evidence: decisionEvidenceSchema,
  })
  .strict();

export const cancelReturnCaseSchema = z
  .object({ ...command, reason: z.string().trim().min(1).max(500) })
  .strict();

export const requestReturnCreationSchema = z
  .object({ id: z.string().uuid(), warehouse: sourceRef, reason: sourceRef })
  .strict();

export const decideReturnCreationSchema = z
  .object({
    decisionId: z.string().uuid(),
    outcome: z.enum(['approved', 'rejected']),
  })
  .strict();

const returnOptionSchema = sourceRef.extend({ name: z.string().nullable() });

export const returnCreationOptionsSchema = z.object({
  warehouses: z.array(returnOptionSchema),
  reasons: z.array(returnOptionSchema),
});

const returnCaseSummarySchema = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid(),
  connectionId: z.string().uuid(),
  sourceReturnId: z.string().uuid().nullable(),
  state: z.enum(['open', 'cancelled']),
  stage: returnCaseStageSchema,
  units: z.number().int(),
  assignee: personSchema.nullable(),
  resolution: resolutionKindSchema.nullable(),
  externalNumber: z.string().nullable(),
  openedAt: z.string(),
  updatedAt: z.string(),
});

export const returnCaseListSchema = z.object({
  items: z.array(
    returnCaseSummarySchema.extend({ orderNumber: z.string().nullable() }),
  ),
  nextCursor: z.string().nullable(),
});

const decidedSchema = z.object({
  by: personSchema,
  at: z.string(),
  evidence: decisionEvidenceSchema,
});

const historyLineSchema = z.object({
  orderLineId: z.string(),
  quantity: z.number().optional(),
  received: z.number().optional(),
  resellable: z.number().optional(),
  damaged: z.number().optional(),
  restock: z.number().optional(),
});

const returnCreationSchema = z.object({
  operation: z.enum(['create', 'approve']).optional(),
  id: z.string().uuid(),
  state: returnCreationStateSchema,
  connectionId: z.string().uuid(),
  warehouse: z.object({ name: z.string().nullable() }),
  reason: z.object({ name: z.string().nullable() }),
  lines: z.array(z.object({ orderLineId: z.string(), quantity: z.number() })),
  requestedBy: personSchema,
  requestedAt: z.string(),
  expiresAt: z.string(),
  decidedBy: personSchema.nullable(),
  decidedAt: z.string().nullable(),
  decisionId: z.string().nullable(),
  approvalOutcome: z.enum(['approved', 'rejected']).nullable(),
  externalReturn: z
    .object({ externalId: z.string(), number: z.string().nullable() })
    .nullable(),
  createdAt: z.string().nullable(),
  failure: returnCreationFailureSchema.nullable(),
  observeOnly: z.boolean(),
  canApprove: z.boolean(),
  canSend: z.boolean(),
  canCheck: z.boolean(),
});

export const returnCaseDetailSchema = z.object({
  case: returnCaseSummarySchema.extend({
    revision: z.number().int(),
    openedBy: personSchema,
    cancellation: z
      .object({ by: personSchema, at: z.string(), reason: z.string() })
      .nullable(),
  }),
  order: z.object({
    id: z.string().uuid(),
    number: z.string().nullable(),
    connection: z.object({
      id: z.string().uuid(),
      label: z.string().nullable(),
      provider: z.string().nullable(),
    }),
  }),
  sourceReturn: z
    .object({
      id: z.string().uuid(),
      name: z.string().nullable(),
      status: z.string(),
    })
    .nullable(),
  lines: z.array(
    z.object({
      orderLineId: z.string(),
      title: z.string().nullable(),
      sku: z.string().nullable(),
      quantity: z.number().int(),
      reason: returnCaseReasonSchema,
      note: z.string().nullable(),
      received: z.number().int().nullable(),
      missing: z.number().int().nullable(),
      resellable: z.number().int().nullable(),
      damaged: z.number().int().nullable(),
      restock: z.number().int().nullable(),
    }),
  ),
  receipt: decidedSchema.nullable(),
  inspection: decidedSchema.nullable(),
  proposal: decidedSchema.extend({ kind: resolutionKindSchema }).nullable(),
  history: z.array(
    z.object({
      id: z.string(),
      kind: z.enum([
        'opened',
        'assigned',
        'receipt_recorded',
        'inspection_recorded',
        'resolution_proposed',
        'cancelled',
        'creation_requested',
        'creation_approved',
        'creation_rejected',
        'creation_created',
      ]),
      actor: personSchema,
      at: z.string(),
      evidence: decisionEvidenceSchema.nullable(),
      details: z.object({
        lines: z.array(historyLineSchema).optional(),
        assigneeId: z.string().nullable().optional(),
        assignee: personSchema.nullable().optional(),
        resolution: resolutionKindSchema.optional(),
        reason: z.string().optional(),
        creationId: z.string().optional(),
        externalNumber: z.string().nullable().optional(),
      }),
    }),
  ),
  creation: returnCreationSchema.nullable(),
  creationAvailability: z.object({
    blocker: returnCreationBlockerSchema.nullable(),
    connection: z.object({ id: z.string(), label: z.string() }).nullable(),
  }),
  canManage: z.boolean(),
  asOf: z.string(),
});

export const orderReturnCasesSchema = z.object({
  sources: z.array(
    z.object({
      connectionId: z.string().uuid(),
      displayNumber: z.string().nullable(),
      lines: z.array(
        z.object({
          orderLineId: z.string(),
          title: z.string().nullable(),
          sku: z.string().nullable(),
          unit: z.string(),
          ordered: z.number(),
          inCases: z.number(),
          inStoreReturns: z.number(),
          returnable: z.number(),
        }),
      ),
      storeReturns: z.array(
        z.object({
          id: z.string().uuid(),
          name: z.string().nullable(),
          status: returnStatusSchema,
          caseId: z.string().uuid().nullable(),
        }),
      ),
    }),
  ),
  cases: z.array(returnCaseSummarySchema),
  canManage: z.boolean(),
});

export type ReturnCaseReason = z.infer<typeof returnCaseReasonSchema>;

export type ResolutionKind = z.infer<typeof resolutionKindSchema>;

export type ReturnCaseStage = z.infer<typeof returnCaseStageSchema>;

export type ReturnCreationState = z.infer<typeof returnCreationStateSchema>;

export type ReturnCreationFailure = z.infer<typeof returnCreationFailureSchema>;

export type ReturnCreationBlocker = z.infer<typeof returnCreationBlockerSchema>;

export type DecisionEvidence = z.infer<typeof decisionEvidenceSchema>;

export type ReturnCaseDetail = z.infer<typeof returnCaseDetailSchema>;

export type OrderReturnCases = z.infer<typeof orderReturnCasesSchema>;
