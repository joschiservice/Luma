import { z } from 'zod';

const id = z.string().uuid();
const decimal = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/);
const ids = z.array(id).max(100);
const timestamp = z.string().datetime({ offset: true });
const mode = z.enum(['manual', 'assisted', 'autonomous']);

/** Initial delegation is restricted to internal follow-up notes; it cannot commit supplier orders. */
const autonomyScopeSchema = z
  .object({
    capability: z.literal('procurement.follow-up.record'),
    connectionIds: ids.min(1),
    supplierIds: ids,
    locationIds: ids,
    recordIds: ids,
    unit: z.literal('follow_up'),
    perActionQuantity: decimal,
    dailyQuantity: decimal,
    money: z
      .object({
        currency: z.string().regex(/^[A-Z]{3}$/),
        perAction: decimal,
        daily: decimal,
      })
      .strict()
      .nullable(),
    maxEvidenceAgeSeconds: z.number().int().min(1).max(300),
  })
  .strict();

export const autonomyPolicySchema = z.object({
  id,
  tenantId: id,
  revision: z.number().int().positive(),
  name: z.string(),
  scope: autonomyScopeSchema,
  scopeHash: z.string(),
  mode,
  paused: z.boolean(),
  pausedConnectionIds: ids,
  revoked: z.boolean(),
  circuitReason: z
    .enum(['verification_failed', 'uncertain_dispatch', 'evidence_unavailable'])
    .nullable(),
  updatedAt: timestamp,
  updatedBy: z.string(),
});

const rate = z.number().min(0).max(1).nullable();

const autonomyTrackRecordSchema = z.object({
  live: z.number().int().nonnegative(),
  synthetic: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  reviewed: z.number().int().nonnegative(),
  verified: z.number().int().nonnegative(),
  acceptanceRate: rate,
  overrideRate: rate,
  reviewerAgreementRate: rate,
  verificationPassRate: rate,
  failures: z.number().int().nonnegative(),
  promotionEligible: z.boolean(),
});

export const autonomyListSchema = z.object({
  available: z.boolean(),
  policies: z.array(
    autonomyPolicySchema.extend({ trackRecord: autonomyTrackRecordSchema }),
  ),
});

export const autonomyPolicyDraftSchema = z
  .object({
    commandId: id,
    id,
    expectedRevision: z.number().int().nonnegative(),
    name: z.string().trim().min(1).max(120),
    scope: autonomyScopeSchema,
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();

export const autonomyPolicyControlSchema = z
  .object({
    commandId: id,
    expectedRevision: z.number().int().positive(),
    kind: z.enum(['pause', 'resume', 'revoke', 'assist', 'promote']),
    connectionId: id.optional(),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();

export const autonomyPreviewSchema = z.object({
  policyId: id,
  revision: z.number().int().positive(),
  asOf: timestamp,
  trackRecord: autonomyTrackRecordSchema,
  samples: z.array(
    z.object({
      proposalId: id,
      environment: z.enum(['live', 'synthetic', 'unknown']),
      at: timestamp,
      outcome: z.enum(['allowed', 'approval_required', 'denied']),
      reason: z
        .enum([
          'out_of_scope',
          'ambiguous_scope',
          'paused',
          'manual',
          'stale_evidence',
          'quantity_limit',
          'money_unknown',
          'money_limit',
          'risk_floor',
        ])
        .nullable(),
    }),
  ),
});

export type AutonomyPolicy = z.infer<typeof autonomyPolicySchema>;

export type AutonomyPolicyControl = z.infer<typeof autonomyPolicyControlSchema>;

export type AutonomyTrackRecord = z.infer<typeof autonomyTrackRecordSchema>;

/** Immutable proposal for an internal follow-up, with its original workflow and stable receipt. */
const followUpPlanSchema = z.object({
  id,
  tenantId: id,
  workflowRunId: id,
  executionRunId: id,
  stepId: z.string(),
  orderRevision: z.number().int().nonnegative(),
  orderScopeFingerprint: z.string(),
  followUpId: id,
  orderId: id,
  key: z.string(),
  nextCheckAt: timestamp,
  observedAt: timestamp,
  expiresAt: timestamp,
  requestedBy: z.string(),
  createdAt: timestamp,
  previousProposalId: id.nullable(),
});
const followUpReviewSchema = z.object({
  refreshable: z.boolean().default(false),
  refreshBlock: z
    .enum(['workflow_inactive', 'release_unavailable'])
    .nullable()
    .default(null),
  decisionId: id.nullable(),
  outcome: z.enum(['allowed', 'denied', 'approval_required']).nullable(),
  stale: z.boolean(),
  reason: z.string().nullable(),
});

export const scopedFollowUpsSchema = z.object({
  items: z.array(followUpPlanSchema.extend({ review: followUpReviewSchema })),
});

export const refreshFollowUpSchema = z.object({
  previous: followUpPlanSchema,
  proposal: followUpPlanSchema,
  review: followUpReviewSchema,
  approvalRetained: z.literal(false),
});
