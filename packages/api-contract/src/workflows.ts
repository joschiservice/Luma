import { z } from 'zod';

import { activityActorSchema } from './activity.js';
import { codeStepViewSchema, codeTelemetrySchema } from './code-steps.js';
import {
  playbookActivationSchema,
  playbookDetailSchema,
  playbookRunViewSchema,
  playbookSummarySchema,
  playbookVersionViewSchema,
} from './playbooks.js';

const text = z.string().min(1);

const workflowTriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exception'), issueType: text }),
  z.object({ kind: z.literal('manual') }),
  z.object({ kind: z.literal('event'), eventType: text }),
  z.object({ kind: z.literal('schedule'), at: z.string().datetime() }),
  z.object({
    kind: z.literal('condition'),
    field: text,
    equals: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
  }),
]);

export const workflowActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), id: text }),
  z.object({
    kind: z.literal('agent'),
    id: text,
    operatorId: text,
    grantId: text,
  }),
]);
const fields = z.record(text, z.enum(['string', 'number', 'boolean', 'null']));

const workflowVersionBaseSchema = playbookVersionViewSchema
  .omit({ issueType: true })
  .extend({
    category: text,
    format: z.enum(['workflow/1', 'resolution-playbook/0']),
    applicability: z.object({
      trigger: workflowTriggerSchema,
      subjectKind: text,
    }),
    inputs: fields,
    context: z.object({
      kind: text,
      fields,
      maxAgeSeconds: z.number().int().positive(),
    }),
    policy: z.object({
      approval: z.enum(['policy', 'required']),
      minimumRisk: z.enum(['low', 'medium', 'high']),
    }),
    outcome: z.object({
      kind: z.literal('verified_postcondition'),
      evaluatorVersion: text,
      onUnverified: z.literal('escalate'),
    }),
  });

const workflowVersionViewSchema = z.union([
  workflowVersionBaseSchema,
  workflowVersionBaseSchema.omit({ policy: true, outcome: true }).extend({
    format: z.literal('workflow/2'),
    finalOutcome: text.nullable(),
    codeSteps: z.array(codeStepViewSchema).optional(),
    executionMode: z.literal('computation').optional(),
  }),
]);

/** Where an operator repairs an issue. `server` means only whoever runs Luma can fix it. */
const readinessRepairSchema = z.object({
  label: text,
  destination: z.enum([
    'connections',
    'suppliers',
    'inventory',
    'inventory_position',
    'purchase_order',
    'workflow_rules',
    'workflow_activity',
    'needs_you',
    'server',
  ]),
  /** The exact connection, record, run or decision to open. */
  recordId: text.optional(),
});

const readinessIssueSchema = z.object({
  code: text,
  /** `blocking` stops the workflow; `degrading` stops part of its coverage. */
  severity: z.enum(['blocking', 'degrading']),
  message: text,
  /** The affected record, when the issue isn't workflow-wide. */
  scope: text.nullable(),
  repair: readinessRepairSchema.nullable(),
});

export const approvalBehaviorSchema = z.object({
  mode: z.enum(['every_action', 'risk_based', 'no_actions']),
  summary: text,
  details: z.array(text),
});

/**
 * Whether a workflow is turned on, whether it can run, what it covers and what needs to happen
 * next. Unknown coverage and untracked decisions are null, never zero.
 */
export const workflowReadinessSchema = z.object({
  enablement: z.enum(['enabled', 'paused', 'not_enabled']),
  state: z.enum(['ready', 'degraded', 'blocked']),
  issues: z.array(readinessIssueSchema),
  coverage: z.object({
    unit: text,
    covered: z.number().int().nonnegative().nullable(),
    ready: z.number().int().nonnegative().nullable(),
    explanation: text,
  }),
  approval: approvalBehaviorSchema,
  waiting: z.object({
    count: z.number().int().nonnegative().nullable(),
    repair: readinessRepairSchema.nullable(),
  }),
  outcomes: z
    .object({
      runs: z.number().int().nonnegative(),
      verified: z.number().int().nonnegative(),
      unresolved: z.number().int().nonnegative(),
      inProgress: z.number().int().nonnegative(),
      latest: z
        .object({
          runId: text,
          state: z.enum(['verified', 'unresolved', 'in_progress', 'ended']),
          at: z.string().datetime(),
          summary: text,
        })
        .nullable(),
    })
    .nullable(),
  nextAction: z.object({
    label: text,
    description: text,
    repair: readinessRepairSchema.nullable(),
  }),
});

export const workflowSummarySchema = playbookSummarySchema
  .omit({ issueType: true })
  .extend({ category: text, readiness: workflowReadinessSchema });

export const workflowDetailSchema = playbookDetailSchema.extend({
  /** Selects an optional domain view; unknown keys use the standard workflow view. */
  presentation: z.string().min(1).optional(),
  summary: workflowSummarySchema,
  versions: z.array(workflowVersionViewSchema),
  policyVersion: z.string(),
  /**
   * The people behind `principalId`, activation grants and reviewers, and version authors that
   * are user IDs. Other authors, such as Luma, are names already.
   */
  people: z.array(activityActorSchema).max(100),
});

export const workflowRunViewSchema = playbookRunViewSchema
  .omit({ incidentId: true })
  .extend({
    activationId: z.string().uuid().nullable(),
    triggerState: z
      .enum(['scheduled', 'awaiting_admission', 'cancelled', 'skipped'])
      .optional(),
    triggerEvidence: z
      .object({ sourceId: text, occurredAt: z.string().datetime() })
      .optional(),
    triggeredAt: z.string().datetime().nullable().optional(),
    story: z.object({
      context: text,
      decision: text,
      action: text,
      verification: text,
    }),
    trigger: workflowTriggerSchema,
    subject: z.object({ kind: text, id: text }),
    actor: workflowActorSchema,
    resolution: z
      .object({
        incidentId: z.string().uuid(),
        diagnosisRevision: z.number().int().nonnegative(),
      })
      .optional(),
    contextDigest: z.string().regex(/^[a-f0-9]{64}$/),
    steps: z.array(
      z.object({
        stepId: text,
        state: text,
        reason: text,
        proposalId: z.string().uuid(),
        decisionId: z.string().nullable(),
      }),
    ),
    processState: z
      .enum([
        'running',
        'awaiting_decision',
        'waiting',
        'verified',
        'ended',
        'denied',
        'failed_verification',
        'not_executed',
        'inconclusive_verification',
        'escalated',
      ])
      .optional(),
    processSteps: z
      .array(
        z.object({
          stepId: text,
          kind: z.enum([
            'code',
            'read',
            'condition',
            'capability',
            'approval',
            'wait',
            'verification',
            'escalation',
            'end',
          ]),
          state: z.enum([
            'not_executed',
            'completed',
            'waiting',
            'denied',
            'failed',
            'inconclusive',
            'ended',
            'escalated',
          ]),
          values: z.record(
            text,
            z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
          ),
          evidenceRefs: z.array(text),
          recordedAt: z.string().datetime(),
          observedAt: z.string().datetime().optional(),
          reason: z.string().optional(),
          code: codeTelemetrySchema.optional(),
        }),
      )
      .optional(),
  });

export const workflowActivationSchema = playbookActivationSchema;

export { activatePlaybookSchema as activateWorkflowSchema } from './playbooks.js';

/**
 * Turns on a workflow that starts for new cases, acting as the caller. The caller reviews the
 * exact version and the approval policy that applies to its changes.
 */
export const activateCaseWorkflowSchema = z
  .object({
    id: z.string().uuid(),
    version: text,
    reviewedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    policyVersion: text,
    scopeReviewed: z.literal(true),
  })
  .strict();

export type ActivateCaseWorkflow = z.infer<typeof activateCaseWorkflowSchema>;

export type WorkflowSummary = z.infer<typeof workflowSummarySchema>;

export type WorkflowReadiness = z.infer<typeof workflowReadinessSchema>;

export type ReadinessRepair = z.infer<typeof readinessRepairSchema>;

export type WorkflowDetail = z.infer<typeof workflowDetailSchema>;

export type WorkflowVersionView = z.infer<typeof workflowVersionViewSchema>;

export type WorkflowRunView = z.infer<typeof workflowRunViewSchema>;

export type WorkflowActor = z.infer<typeof workflowActorSchema>;

export type WorkflowTrigger = z.infer<typeof workflowTriggerSchema>;

export type {
  ActivatePlaybook as ActivateWorkflow,
  PlaybookActivationView as WorkflowActivationView,
  PlaybookConnection as WorkflowConnection,
} from './playbooks.js';

const scalar = z.union([
  z.string().max(2000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

/** Supply an immutable source ID and reuse the complete request when retrying. */
export const fireWorkflowSchema = z
  .object({
    version: z.string().min(1).max(200),
    reviewedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    subject: z
      .object({
        kind: z.string().min(1).max(200),
        id: z.string().min(1).max(200),
      })
      .strict(),
    signal: z
      .object({
        kind: z.enum(['manual', 'schedule', 'event', 'condition', 'exception']),
        sourceId: z.string().min(1).max(200),
        occurredAt: z.string().datetime(),
      })
      .strict(),
    context: z
      .object({
        inputs: z.record(z.string().max(80), scalar),
        evidence: z
          .object({
            kind: z.string().min(1).max(200),
            facts: z.record(z.string().max(80), scalar),
            observations: z
              .array(
                z
                  .object({
                    id: z.string().uuid(),
                    observedAt: z.string().datetime(),
                    source: z.string().min(1).max(200),
                  })
                  .strict(),
              )
              .min(1)
              .max(100),
          })
          .strict(),
        provenance: z
          .object({
            reference: z.string().min(1).max(200),
            capturedAt: z.string().datetime(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type FireWorkflow = z.infer<typeof fireWorkflowSchema>;
