import { z } from 'zod';

import {
  draftStepSchema,
  workflowDiagnosticSchema,
  workflowDraftContentSchema,
  workflowDraftSchema,
} from './workflow-drafts.js';

const scalar = z.union([
  z.string().max(2000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const values = z.record(z.string(), scalar);
const request = z.string().min(1).max(4000).regex(/\S/);

const evaluationTraceSchema = z.object({
  outcome: z.string(),
  effects: z.array(
    z.object({
      key: z.string(),
      capability: z.string(),
      parameters: values,
    }),
  ),
  outputs: z.array(
    z.object({
      stepId: z.string(),
      kind: z.string(),
      state: z.string(),
      values,
      evidenceRefs: z.array(z.string()),
      recordedAt: z.string(),
      observedAt: z.string().optional(),
      reason: z.string().optional(),
      code: z.unknown().optional(),
    }),
  ),
  violations: z.array(z.string()),
});

/** Whether describing workflows is available here, with the reason when it isn't. */
export const generationAvailabilitySchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  improvements: z.boolean().default(false),
  improvementDiscovery: z.boolean().default(false),
});

/** A bounded review queue of independently verified recurring work; discovery changes nothing. */
export const improvementDiscoverySchema = z.object({
  asOf: z.string().datetime(),
  windowDays: z.number().int().positive(),
  minimumIncidents: z.number().int().positive(),
  items: z.array(
    z.object({
      id: z.string(),
      pattern: z.enum(['inventory_mismatch', 'sync_failure']),
      artifact: z.object({
        id: z.string(),
        version: z.string(),
        digest: z.string(),
      }),
      environment: z.enum(['live', 'synthetic', 'unknown']),
      verifiedIncidents: z.number().int().nonnegative(),
      humanInterventions: z.number().int().nonnegative(),
      humanEdits: z.number().int().nonnegative(),
      recordedEffortSeconds: z.number().nonnegative().nullable(),
      recurrences: z.number().int().nonnegative(),
      eligibleForProposal: z.boolean(),
      productionPromotion: z.literal('blocked'),
      missingEvidence: z.array(z.string()),
      sources: z.array(
        z.object({
          incidentId: z.string().uuid(),
          runId: z.string().uuid(),
          subjectId: z.string(),
        }),
      ),
    }),
  ),
});

/** A question the model couldn't answer. It highlights one field in the builder. */
const generationQuestionSchema = z.object({
  stepId: z.string().nullable(),
  field: z.string(),
  question: z.string(),
});

const stepExplanationSchema = z.object({
  stepId: z.string(),
  explanation: z.string(),
});

const generationUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
});

const generationRouteSchema = z.object({
  profile: z.string(),
  adapter: z.string().nullable(),
  model: z.string().nullable(),
});

const generated = {
  id: z.string().uuid(),
  outcome: z.enum(['valid', 'partial']),
  attempts: z.number().int().nonnegative(),
  usage: generationUsageSchema,
  route: generationRouteSchema,
};

const explained = {
  explanations: z.array(stepExplanationSchema),
  assumptions: z.array(z.string()),
  questions: z.array(generationQuestionSchema),
  diagnostics: z.array(workflowDiagnosticSchema),
};

/** Start a draft from a description. Reuse the same ID and body after an uncertain response. */
export const describeWorkflowSchema = z
  .object({
    id: z.string().uuid(),
    draftId: z.string().uuid(),
    prompt: request,
  })
  .strict();

export const generatedDraftSchema = z.object({
  draft: workflowDraftSchema,
  generation: z.object({ ...generated, ...explained }),
});

/** Ask for a change to the revision you loaded. Reuse the same ID and body after an uncertain response. */
export const refineWorkflowDraftSchema = z
  .object({
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    instruction: request,
    improvement: z
      .object({ incidentId: z.string().uuid(), runId: z.string().uuid() })
      .strict()
      .optional(),
  })
  .strict();

/** One step-level difference. Workflow settings have a null step ID and name the setting in `field`. */
const draftChangeSchema = z.object({
  change: z.enum(['added', 'removed', 'changed', 'moved']),
  stepId: z.string().nullable(),
  field: z.string().nullable(),
  before: draftStepSchema.nullable(),
  after: draftStepSchema.nullable(),
  summary: z.string(),
});

export const draftProposalSchema = z.object({
  ...generated,
  ...explained,
  draftId: z.string().uuid(),
  baseRevision: z.number().int().positive(),
  resultingRevision: z.number().int().positive().nullable(),
  state: z.enum(['open', 'accepted', 'rejected']),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().datetime().nullable(),
  content: workflowDraftContentSchema,
  changes: z.array(draftChangeSchema),
  improvement: z
    .object({
      evidence: z.object({
        incidentId: z.string(),
        runId: z.string(),
        pattern: z.enum(['inventory_mismatch', 'sync_failure']),
        subjectId: z.string(),
        evidenceRefs: z.array(z.string()),
        evaluatorVersion: z.string(),
        verifiedAt: z.string().datetime(),
        artifactDigest: z.string(),
        repairCodes: z.array(z.string()),
        humanInterventions: z.number().int().nonnegative(),
      }),
      baselineDigest: z.string(),
      candidateDigest: z.string(),
      schemaVersion: z.literal('workflow/2'),
      requiredCapabilities: z.array(z.string()),
      rollout: z.object({
        kind: z.literal('selected_subjects'),
        subjectIds: z.array(z.string()),
      }),
      humanSteps: z.array(z.string()),
      coverage: z.enum(['not_evaluated', 'synthetic_passed', 'failed']),
      missingCoverage: z.array(z.string()),
      evaluation: z
        .object({
          suiteVersion: z.literal('workflow-improvement-safety/1'),
          assertionVersion: z.literal('workflow-improvement-invariants/1'),
          fixtureHash: z.string(),
          source: z.literal('synthetic'),
          passed: z.boolean(),
          controls: z
            .object({
              suiteVersion: z.literal('workflow-control-simulator/1'),
              source: z.literal('disposable_committed_fixture'),
              tenantId: z.string(),
              actorId: z.string(),
              baselineDigest: z.string(),
              candidateDigest: z.string(),
              passed: z.boolean(),
              versions: z.array(
                z.object({
                  digest: z.string(),
                  checks: z.array(
                    z.object({
                      id: z.string(),
                      passed: z.boolean(),
                      applicable: z.boolean(),
                    }),
                  ),
                  actions: z.number().int().nonnegative(),
                  effects: z.number().int().nonnegative(),
                  recovery: z.literal('committed_postgres_temporal'),
                }),
              ),
            })
            .optional(),
          historical: z
            .object({
              source: z.literal('retained_workflow_runs'),
              assertionVersion: z.literal('workflow-historical-invariants/1'),
              passed: z.boolean(),
              captures: z.array(
                z.object({
                  runId: z.string(),
                  versionDigest: z.string(),
                  contextDigest: z.string(),
                  captureDigest: z.string(),
                  baseline: evaluationTraceSchema,
                  candidate: evaluationTraceSchema,
                  passed: z.boolean(),
                  missingInputs: z.array(z.string()),
                }),
              ),
              counterexamples: z.array(z.string()),
              missingInputs: z.array(z.string()),
            })
            .optional(),
          scenarios: z.array(
            z.object({
              id: z.string(),
              seed: z.number().int(),
              passed: z.boolean(),
              baseline: evaluationTraceSchema,
              candidate: evaluationTraceSchema,
            }),
          ),
          counterexamples: z.array(z.string()),
          missingCoverage: z.array(z.string()),
        })
        .optional(),
    })
    .nullable()
    .default(null),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
});

/** Accept against the revision the change was proposed for. Reuse the same save ID after an uncertain response. */
export const acceptProposalSchema = z
  .object({
    revision: z.number().int().positive(),
    saveId: z.string().uuid(),
  })
  .strict();

export const acceptedProposalSchema = z.object({
  draft: workflowDraftSchema,
  proposal: draftProposalSchema,
});

/** Describe a calculation for a Code Step in the saved draft, or for a new step (`stepId: null`). */
export const codeStepSuggestionRequestSchema = z
  .object({
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    stepId: z
      .string()
      .regex(/^[a-z][a-zA-Z0-9_-]{0,79}$/)
      .nullable(),
    description: request,
  })
  .strict();

/** An example case in the Code Step evaluator's input format. */
const codeStepExampleSchema = z.object({
  name: z.string(),
  input: z.object({
    inputs: values,
    evidence: values,
    steps: z.record(z.string(), values),
  }),
  replies: z.record(z.string(), values),
  expected: values,
});

export const codeStepSuggestionSchema = z.object({
  ...generated,
  draftId: z.string().uuid(),
  stepId: z.string().nullable(),
  source: z.string(),
  fields: z.record(z.string(), z.enum(['string', 'number', 'boolean', 'null'])),
  grants: z.array(z.string()),
  explanation: z.string(),
  examples: z.array(codeStepExampleSchema),
  diagnostics: z.array(workflowDiagnosticSchema),
});

/** Provenance for one generation. It records authorship and usage; it approves nothing. */
export const workflowGenerationSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['describe', 'refine', 'code_step']),
  draftId: z.string().uuid().nullable(),
  baseRevision: z.number().int().positive().nullable(),
  resultingRevision: z.number().int().positive().nullable(),
  promptVersion: z.string(),
  promptDigest: z.string(),
  route: generationRouteSchema,
  usage: generationUsageSchema,
  attempts: z.number().int().nonnegative(),
  outcome: z.enum(['valid', 'partial', 'failed']),
  proposalState: z.enum(['open', 'accepted', 'rejected']).nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().datetime().nullable(),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
});

export type DescribeWorkflow = z.infer<typeof describeWorkflowSchema>;

export type GeneratedDraft = z.infer<typeof generatedDraftSchema>;

export type RefineWorkflowDraft = z.infer<typeof refineWorkflowDraftSchema>;

export type DraftProposal = z.infer<typeof draftProposalSchema>;

export type AcceptProposal = z.infer<typeof acceptProposalSchema>;

export type CodeStepSuggestionRequest = z.infer<
  typeof codeStepSuggestionRequestSchema
>;

export type CodeStepSuggestion = z.infer<typeof codeStepSuggestionSchema>;
