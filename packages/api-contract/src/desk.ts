import { z } from 'zod';

import { actionDiffSchema } from './action-diff.js';
import { activityActorSchema } from './activity.js';
import { caseStates } from './cases.js';

const id = z.string().uuid();

const at = z.string().datetime();

const ref = z.string().min(1).max(512);

// People referenced by user ID in a case response, named as in Activity. A listed ID that
// names nobody in the workspace reads as a former member.
const casePeople = z.array(activityActorSchema).max(100);

const fields = z.record(
  z.string(),
  z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()]),
);

export const caseDecisionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      commandId: id,
      kind: z.literal('close'),
      caseRevision: z.number().int().positive(),
      diagnosisRevision: z.number().int().nonnegative(),
      reason: z.string().trim().min(1).max(1000),
      evidenceRefs: z.array(ref).max(100).default([]),
    })
    .strict(),
  z
    .object({
      commandId: id,
      kind: z.literal('approve'),
      caseRevision: z.number().int().positive(),
      diagnosisRevision: z.number().int().nonnegative(),
      proposalId: id,
      proposalVersion: z.number().int().positive(),
      decisionId: id,
      reason: z.string().trim().min(1).max(1000),
    })
    .strict(),
  z
    .object({
      commandId: id,
      kind: z.literal('reject'),
      caseRevision: z.number().int().positive(),
      diagnosisRevision: z.number().int().nonnegative(),
      proposalId: id,
      proposalVersion: z.number().int().positive(),
      decisionId: id,
      reason: z.string().trim().min(1).max(1000),
    })
    .strict(),
  z
    .object({
      commandId: id,
      kind: z.literal('escalate'),
      caseRevision: z.number().int().positive(),
      diagnosisRevision: z.number().int().nonnegative(),
      reason: z.string().trim().min(1).max(1000),
    })
    .strict(),
]);

export const decisionReceiptSchema = z.object({
  id,
  exceptionId: id,
  kind: z.enum(['approve', 'reject', 'escalate', 'close']),
  actorId: ref,
  caseRevision: z.number().int().positive(),
  approvalId: id.nullable(),
  reason: z.string().min(1).max(1000),
  createdAt: at,
});

export const caseReviewSchema = z.object({
  observeOnly: z.boolean().optional(),
  /** The people behind `proposal.requestedBy` and `proposal.approval.actorId`. */
  people: casePeople,
  policyStale: z.boolean().optional(),
  refreshable: z.boolean().optional(),
  schemaVersion: z.literal(1),
  caseRevision: z.number().int().positive(),
  diagnosisRevision: z.number().int().nonnegative(),
  permittedDecisions: z
    .array(z.enum(['approve', 'reject', 'escalate', 'close']))
    .max(4),
  proposal: z
    .object({
      id,
      version: z.number().int().positive(),
      diagnosisRevision: z.number().int().positive(),
      capability: ref,
      capabilityVersion: ref,
      available: z.boolean(),
      connectionId: id,
      target: z.object({ kind: ref, id }),
      parameters: fields,
      expectedPostcondition: fields,
      diff: actionDiffSchema.nullable().optional(),
      preconditions: z.object({
        evidenceRefs: z.array(ref).max(100),
        validUntil: at,
      }),
      risk: z.enum(['low', 'medium', 'high']),
      expiresAt: at,
      requestedBy: ref,
      policy: z
        .object({
          id,
          policyVersion: ref,
          outcome: z.enum(['allowed', 'denied', 'approval_required']),
          reason: ref,
          evaluatedAt: at,
          validUntil: at,
        })
        .nullable(),
      approval: z
        .object({
          id,
          outcome: z.enum(['approved', 'rejected']),
          actorId: ref,
          createdAt: at,
        })
        .nullable(),
    })
    .nullable(),
});

const caseExecutionSchema = z
  .object({
    id,
    proposalId: id,
    state: z.enum(['prepared', 'unknown', 'succeeded', 'failed']),
    attemptId: id,
    attempt: z.number().int().positive(),
    requestedBy: ref,
    executor: z.object({
      kind: z.enum(['service', 'agent', 'connector', 'user']),
      id: ref,
    }),
    startedAt: at,
    finishedAt: at.nullable(),
    effectEvidenceRefs: z.array(ref).max(100),
    verification: z
      .object({
        outcome: z.enum(['passed', 'failed', 'inconclusive']),
        observationRefs: z.array(ref).max(100),
        observedAt: at,
        evaluatorVersion: ref,
      })
      .nullable(),
  })
  .nullable();

export const caseProgressSchema = z.object({
  workflowRuns: z
    .array(
      z.object({
        id,
        definitionId: ref,
        name: ref,
        version: ref,
        truncated: z.boolean(),
        steps: z
          .array(
            z.object({
              stepId: ref,
              kind: ref,
              state: ref,
              recordedAt: at,
              observedAt: at.nullable(),
              evidenceRefs: z.array(ref).max(100),
            }),
          )
          .max(100),
        actions: z
          .array(
            z.object({
              proposalId: id,
              capability: ref,
              diff: actionDiffSchema.nullable(),
              approval: z
                .object({
                  actorId: ref,
                  outcome: z.enum(['approved', 'rejected']),
                  createdAt: at,
                })
                .nullable(),
              execution: caseExecutionSchema,
            }),
          )
          .max(100),
      }),
    )
    .max(10)
    .optional(),
  workflowRunsTruncated: z.boolean().optional(),
  schemaVersion: z.literal(1),
  /** The people behind `execution.requestedBy` and `resolution.actorId`. */
  people: casePeople,
  caseRevision: z.number().int().positive(),
  state: z.enum(caseStates),
  diagnosisRevision: z.number().int().nonnegative(),
  execution: caseExecutionSchema,
  resolution: z
    .object({
      kind: z.enum(['verification', 'human_disposition']),
      at,
      actorId: ref,
      reason: z.string().max(1000).optional(),
      evidenceRefs: z.array(ref).max(100),
    })
    .nullable(),
  workflow: z.object({
    availability: z.enum(['available', 'not_started', 'unavailable']),
    progress: z
      .object({
        phase: z.enum([
          'detecting',
          'diagnosing',
          'proposing',
          'executing',
          'awaiting_approval',
          'reconciling',
          'verifying',
          'resolved',
          'no_incident',
          'shadow_completed',
          'not_executed',
          'escalated',
          'denied',
        ]),
        exceptionId: id.optional(),
        proposalId: id.optional(),
        decisionId: id.optional(),
        reason: ref.optional(),
      })
      .nullable(),
  }),
});

export const caseTimelineSchema = z.object({
  items: z
    .array(
      z.object({
        id,
        type: ref,
        occurredAt: at,
        actor: activityActorSchema,
        proposalId: id.nullable(),
        outcome: ref.nullable(),
        reason: z.string().max(1000).nullable().optional(),
        evidenceRefs: z.array(ref).max(100),
      }),
    )
    .max(100),
  nextCursor: z.string().nullable(),
});

export const caseStreamEventSchema = z.object({
  schemaVersion: z.literal(1),
  exceptionId: id,
  refetch: z.literal(true),
  progress: caseProgressSchema,
});

export type CaseDecision = z.infer<typeof caseDecisionSchema>;

export type DecisionReceipt = z.infer<typeof decisionReceiptSchema>;

export type CaseReview = z.infer<typeof caseReviewSchema>;

export type CaseProgress = z.infer<typeof caseProgressSchema>;

export type CaseTimelinePage = z.infer<typeof caseTimelineSchema>;
