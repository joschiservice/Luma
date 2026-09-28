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

/** Whether describing workflows is available here, with the reason when it isn't. */
export const generationAvailabilitySchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
});

/** A question the model couldn't answer. It highlights one field in the builder. */
export const generationQuestionSchema = z.object({
  stepId: z.string().nullable(),
  field: z.string(),
  question: z.string(),
});

export const stepExplanationSchema = z.object({
  stepId: z.string(),
  explanation: z.string(),
});

export const generationUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
});

export const generationRouteSchema = z.object({
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
  })
  .strict();

/** One step-level difference. Workflow settings have a null step ID and name the setting in `field`. */
export const draftChangeSchema = z.object({
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
export const codeStepExampleSchema = z.object({
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

export type GenerationAvailability = z.infer<
  typeof generationAvailabilitySchema
>;

export type GenerationQuestion = z.infer<typeof generationQuestionSchema>;

export type DescribeWorkflow = z.infer<typeof describeWorkflowSchema>;

export type GeneratedDraft = z.infer<typeof generatedDraftSchema>;

export type RefineWorkflowDraft = z.infer<typeof refineWorkflowDraftSchema>;

export type DraftChange = z.infer<typeof draftChangeSchema>;

export type DraftProposal = z.infer<typeof draftProposalSchema>;

export type AcceptProposal = z.infer<typeof acceptProposalSchema>;

export type CodeStepSuggestionRequest = z.infer<
  typeof codeStepSuggestionRequestSchema
>;

export type CodeStepSuggestion = z.infer<typeof codeStepSuggestionSchema>;

export type WorkflowGeneration = z.infer<typeof workflowGenerationSchema>;
