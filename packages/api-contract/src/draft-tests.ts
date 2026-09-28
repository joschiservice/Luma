import { z } from 'zod';

import { codeTelemetrySchema } from './code-steps.js';
import { workflowStepKinds } from './workflow-drafts.js';

const scalar = z.union([
  z.string().max(2000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const name = z.string().max(80);
const values = z
  .record(name, scalar)
  .refine((items) => Object.keys(items).length <= 64, {
    message: 'Use at most 64 values.',
  });
const shownValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const shownValues = z.record(z.string(), shownValue);

/** Final outcomes of a test run. `awaiting_decision` means the workflow would wait for a person. */
export const testOutcomeSchema = z.enum([
  'verified',
  'ended',
  'denied',
  'failed_verification',
  'inconclusive_verification',
  'escalated',
  'awaiting_decision',
]);

/** The example reply a step receives instead of calling a connected system. */
export const stepReplySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('read'), values }).strict(),
  z
    .object({
      kind: z.literal('approval'),
      decision: z.enum(['approved', 'denied', 'pending']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('capability'),
      result: z.enum(['accepted', 'approval_required', 'denied']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('verification'),
      state: z.enum(['verified', 'failed', 'inconclusive']),
      values,
    })
    .strict(),
]);

/**
 * Example data for one test: inputs and context facts for the run, and replies keyed by step ID.
 * A missing approval reply means nobody has decided yet, so the run pauses there.
 */
export const draftTestCaseSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(200),
    inputs: values,
    evidence: values,
    replies: z
      .record(name, stepReplySchema)
      .refine((items) => Object.keys(items).length <= 64, {
        message: 'Use at most 64 replies.',
      }),
    expected: z.object({ outcome: testOutcomeSchema }).strict().nullable(),
  })
  .strict();

export const testStepResultSchema = z.object({
  stepId: z.string(),
  kind: z.enum(workflowStepKinds),
  title: z.string(),
  state: z.enum([
    'completed',
    'waiting',
    'denied',
    'failed',
    'inconclusive',
    'ended',
    'escalated',
  ]),
  inputs: shownValues,
  outputs: shownValues,
  branch: z
    .enum(['continued', 'ended', 'escalated', 'paused', 'denied'])
    .nullable(),
  note: z.string(),
  code: codeTelemetrySchema.optional(),
});

export const draftTestResultSchema = z.object({
  outcome: testOutcomeSchema,
  stoppedAt: z.string().nullable(),
  reason: z.string().nullable(),
  passed: z.boolean().nullable(),
  steps: z.array(testStepResultSchema),
});

export const draftTestRunSchema = z.object({
  id: z.string().uuid(),
  draftId: z.string().uuid(),
  revision: z.number().int().positive(),
  caseId: z.string().uuid().nullable(),
  state: z.enum(['running', 'completed', 'failed', 'cancelled']),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  result: draftTestResultSchema.nullable(),
  error: z.string().nullable(),
});

export const draftTestSummarySchema = z.object({
  draftRevision: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  cases: z.array(draftTestCaseSchema),
  results: z.array(
    z.object({
      caseId: z.string().uuid(),
      runId: z.string().uuid().nullable(),
      state: z.enum(['running', 'completed', 'failed', 'cancelled']).nullable(),
      outcome: testOutcomeSchema.nullable(),
      passed: z.boolean().nullable(),
      error: z.string().nullable(),
    }),
  ),
  blocked: z.string().nullable(),
});

export const draftTestExamplesSchema = z.object({
  fields: draftTestCaseSchema,
  runs: z.array(
    z.object({
      runId: z.string(),
      createdAt: z.string(),
      case: draftTestCaseSchema,
    }),
  ),
  scenarios: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      case: draftTestCaseSchema,
    }),
  ),
});

/** Replace the saved cases against the revision you loaded; use 0 before any are saved. */
export const saveDraftTestsSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    cases: z.array(draftTestCaseSchema).max(20),
  })
  .strict();

export const runDraftTestsSchema = z
  .object({ revision: z.number().int().positive() })
  .strict();

/** Start one run with a saved case (`caseId`) or an unsaved one (`case`), not both. */
export const startDraftTestSchema = z
  .object({
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    caseId: z.string().uuid().optional(),
    case: draftTestCaseSchema.optional(),
  })
  .strict()
  .refine((body) => !body.caseId !== !body.case, {
    message: 'Provide a saved case ID or a case, not both.',
  });

export type StepReply = z.infer<typeof stepReplySchema>;

export type TestOutcome = z.infer<typeof testOutcomeSchema>;

export type DraftTestCase = z.infer<typeof draftTestCaseSchema>;

export type TestStepResult = z.infer<typeof testStepResultSchema>;

export type DraftTestResult = z.infer<typeof draftTestResultSchema>;

export type DraftTestRun = z.infer<typeof draftTestRunSchema>;

export type DraftTestSummary = z.infer<typeof draftTestSummarySchema>;

export type DraftTestExamples = z.infer<typeof draftTestExamplesSchema>;

export type SaveDraftTests = z.infer<typeof saveDraftTestsSchema>;

export type StartDraftTest = z.infer<typeof startDraftTestSchema>;
