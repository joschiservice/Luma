import { z } from 'zod';

const value = z.union([
  z.string().max(1000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

/** An evidence-bound action review. Known null and unknown are represented separately. */
export const actionDiffSchema = z.object({
  schemaVersion: z.literal(1),
  policy: z
    .object({
      outcome: z.enum(['allowed', 'denied', 'approval_required']),
      reason: z.string(),
      evaluatedAt: z.string().datetime(),
      validUntil: z.string().datetime(),
      current: z.boolean(),
    })
    .nullable()
    .optional(),
  capability: z.string(),
  records: z
    .array(
      z.object({
        system: z.enum(['luma', 'provider']),
        connectionId: z.string().uuid().nullable(),
        kind: z.string(),
        id: z.string().nullable(),
        link: z
          .string()
          .regex(/^\/app\//)
          .optional(),
        changes: z
          .array(
            z.object({
              field: z.string(),
              before: value,
              beforeKnown: z.boolean(),
              after: value,
              afterKnown: z.boolean(),
              expected: value,
              expectedKnown: z.boolean(),
            }),
          )
          .max(250),
      }),
    )
    .max(100),
  scope: z
    .array(
      z.object({
        kind: z.string(),
        count: z.number().int().nonnegative().nullable(),
        ids: z.array(z.string()).max(100),
      }),
    )
    .max(20),
  reversibility: z.enum([
    'reversible',
    'compensatable',
    'irreversible',
    'unknown',
  ]),
  evidence: z.object({
    link: z
      .string()
      .regex(/^\/app\//)
      .optional(),
    refs: z.array(z.string()).max(100),
    observedAt: z.string().datetime({ offset: true }).nullable(),
    ageSeconds: z.number().nonnegative().nullable().optional(),
    validUntil: z.string().datetime({ offset: true }),
  }),
  retryProtection: z.literal('immutable_intent_reconcile_before_retry'),
  canonicalOutcome: z.enum(['requires_fresh_verification', 'internal_record']),
});

export type ActionDiff = z.infer<typeof actionDiffSchema>;
