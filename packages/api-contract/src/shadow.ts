import { z } from 'zod';

const code = z.string().min(1).max(200);
const fields = z.record(
  z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()]),
);

export const shadowRequestSchema = z
  .object({ id: z.string().uuid(), workflow: code })
  .strict();

export const shadowReviewSchema = z
  .object({
    actionNeeded: z.boolean(),
    eligible: z.boolean(),
    operatorAction: z
      .object({
        capability: code,
        target: z.object({ kind: code, id: z.string().uuid() }).strict(),
        parameters: fields,
        expectedPostcondition: fields,
      })
      .strict()
      .nullable(),
    evidenceRefs: z.array(z.string().uuid()).min(1).max(100),
    occurredAt: z.string().datetime(),
    feedback: z.enum(['trust', 'distrust', 'unsure']).nullable(),
  })
  .strict();

export const shadowWindowSchema = z
  .object({
    workflow: code,
    since: z.string().datetime(),
    until: z.string().datetime(),
  })
  .strict()
  .refine(
    (v) => Date.parse(v.since) < Date.parse(v.until),
    'The end must follow the start',
  );

export const shadowEvaluationSchema = z.object({
  id: z.string().uuid(),
  incidentId: z.string().uuid(),
  actorId: z.string(),
  workflow: code,
  mode: z.literal('shadow'),
  executed: z.literal(false),
  createdAt: z.string().datetime(),
  diagnosis: z.record(z.unknown()).nullable(),
  candidate: z.record(z.unknown()).nullable(),
  eligibility: z.enum([
    'eligible',
    'ineligible',
    'stale_evidence',
    'no_candidate',
  ]),
  policy: z
    .object({
      outcome: z.enum(['allowed', 'denied', 'approval_required']),
      reason: code,
      version: code,
    })
    .nullable(),
  simulation: z.object({
    modelVersion: z.literal('shipping-method-shadow/1'),
    effects: fields,
    predictedOutcome: z.enum(['passed', 'inconclusive']),
    evaluatorVersion: code.nullable(),
    assumptions: z.array(z.string()),
  }),
});
const rate = z.object({
  numerator: z.number().int().nonnegative(),
  denominator: z.number().int().nonnegative(),
  rate: z.number().min(0).max(1).nullable(),
});

export const shadowComparisonSchema = z.object({
  evaluation: shadowEvaluationSchema,
  review: shadowReviewSchema.extend({ actorId: z.string() }).nullable(),
  actual: z
    .object({
      outcome: z.enum(['passed', 'failed']),
      evaluatorVersion: code,
      evidenceRefs: z.array(z.string()),
      occurredAt: z.string().datetime(),
    })
    .nullable(),
});

export const shadowReportSchema = z.object({
  mode: z.literal('shadow'),
  workflow: code,
  since: z.string().datetime(),
  until: z.string().datetime(),
  items: z.array(shadowComparisonSchema),
  metrics: z.object({
    evaluations: z.number(),
    reviewed: z.number(),
    agreementWithOperator: rate,
    falsePositiveActionRate: rate,
    missedEligibleCases: rate,
    predictedVsActualOutcome: rate,
    projectedAutonomousResolutionRate: rate,
    projectedUnnecessaryHumanInterventionRate: rate,
    operatorTrust: rate,
  }),
});
