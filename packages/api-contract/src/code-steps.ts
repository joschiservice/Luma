import { z } from 'zod';

const scalar = z.union([
  z.string().max(2000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const values = z.record(z.string().max(80), scalar);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const codeTelemetrySchema = z.object({
  runtime: z.string(),
  artifactDigest: digest,
  inputDigest: digest,
  wallTimeMs: z.number().nonnegative(),
  requests: z.number().int().nonnegative(),
  verifiedActions: z.number().int().nonnegative().optional(),
  peakProcessMemoryBytes: z.number().nonnegative().optional(),
  outcome: z.enum([
    'completed',
    'code_error',
    'resource_limit',
    'cancelled',
    'invalid_output',
    'capability_denied',
    'unavailable',
  ]),
});

export const codeStepViewSchema = z.object({
  id: z.string(),
  kind: z.literal('code'),
  source: z.string(),
  runtime: z.string(),
  artifactDigest: digest,
  fields: z.record(z.string(), z.enum(['string', 'number', 'boolean', 'null'])),
  grants: z.array(z.string()),
  limits: z.object({
    fuel: z.number(),
    memoryBytes: z.number(),
    wallTimeMs: z.number(),
    maxRequests: z.number(),
  }),
});

/** Evaluations use supplied capability replies and never dispatch provider actions. */
export const evaluateCodeSchema = z
  .object({
    id: z.string().uuid(),
    version: z.string().max(200),
    reviewedDigest: digest,
    stepId: z.string().max(80),
    now: z.string().datetime().default('2026-01-01T00:00:00.000Z'),
    input: z
      .object({
        inputs: values,
        evidence: values,
        steps: z.record(z.string().max(80), values),
      })
      .strict(),
    replies: z.record(z.string().max(80), values),
    expected: values,
  })
  .strict();

export const codeEvaluationSchema = z.object({
  id: z.string().uuid(),
  version: z.string(),
  stepId: z.string(),
  state: z.enum(['running', 'passed', 'failed', 'cancelled']),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  result: z.object({ values, telemetry: codeTelemetrySchema }).nullable(),
});

export type EvaluateCode = z.infer<typeof evaluateCodeSchema>;

export type CodeEvaluation = z.infer<typeof codeEvaluationSchema>;
