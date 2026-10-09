import { z } from 'zod';

const code = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/);

const refs = z.array(code).max(100);

const hash = z.string().regex(/^[a-f0-9]{64}$/);

export const startResolutionRunSchema = z
  .object({
    id: z.string().uuid(),
    diagnosisRevision: z.number().int().positive(),
    resolution: z
      .object({
        id: code,
        version: code,
        use: z.enum(['created', 'improved', 'reused', 'partner_specific']),
        reasonCode: code,
        previousVersion: code.optional(),
        partnerCodeRef: code.optional(),
      })
      .strict()
      .superRefine((value, ctx) => {
        if (
          value.use === 'improved' &&
          (!value.previousVersion || value.previousVersion === value.version)
        )
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'An improvement requires a different previous version',
          });
        if (value.use === 'partner_specific' && !value.partnerCodeRef)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Partner-specific work requires a code reference',
          });
      }),
  })
  .strict();

const learningCommandBase = z
  .object({
    id: z.string().uuid(),
    occurredAt: z.string().datetime(),
    fact: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('cause'),
          code,
          status: z.enum(['suspected', 'confirmed', 'rejected']),
          supportingEvidenceRefs: refs,
          contradictingEvidenceRefs: refs,
          basis: z.enum(['model_hypothesis', 'operator_investigation']),
        })
        .strict(),
      z
        .object({
          kind: z.literal('repair_step'),
          stepId: code,
          actionCode: code,
          inputEvidenceRefs: refs.min(1),
          actionHash: hash,
          startedAt: z.string().datetime(),
          finishedAt: z.string().datetime(),
          effortSeconds: z.number().int().nonnegative().max(31536000),
          result: z.enum(['accepted', 'failed', 'unknown']),
        })
        .strict(),
      z
        .object({
          kind: z.literal('intervention'),
          stepId: code,
          reasonCode: code,
          effortSeconds: z.number().int().nonnegative().max(31536000),
          evidenceRefs: refs.min(1),
        })
        .strict(),
      z
        .object({
          kind: z.literal('observation'),
          stepId: code,
          code,
          evidenceRefs: refs.min(1),
        })
        .strict(),
      z
        .object({
          kind: z.literal('human_edit'),
          stepId: code,
          beforeHash: hash,
          afterHash: hash,
          reasonCode: code,
          evidenceRefs: refs.min(1),
        })
        .strict(),
      z
        .object({
          kind: z.literal('outcome'),
          result: z.enum(['pending', 'failed', 'inconclusive', 'verified']),
          evaluatorVersion: code,
          authoritative: z.boolean(),
          complete: z.boolean(),
          evidenceRefs: refs,
          businessResult: z
            .object({
              code,
              value: z.number().finite().nullable(),
              unit: code.nullable(),
            })
            .strict(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('recurrence'),
          incidentId: z.string().uuid(),
          evidenceRefs: refs.min(1),
        })
        .strict(),
    ]),
  })
  .strict();

export const learningCommandSchema = learningCommandBase.superRefine(
  ({ fact, occurredAt }, ctx) => {
    const reject = (message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (fact.kind === 'cause') {
      if (fact.basis === 'model_hypothesis' && fact.status !== 'suspected')
        reject('Model hypotheses remain suspected');
      if (fact.status === 'confirmed' && !fact.supportingEvidenceRefs.length)
        reject('Confirmation requires supporting evidence');
      if (fact.status === 'rejected' && !fact.contradictingEvidenceRefs.length)
        reject('Rejection requires contradicting evidence');
    }
    if (
      fact.kind === 'outcome' &&
      fact.result === 'verified' &&
      (!fact.authoritative || !fact.complete || !fact.evidenceRefs.length)
    )
      reject('Verified outcomes require complete authoritative evidence');
    if (
      fact.kind === 'repair_step' &&
      (Date.parse(fact.finishedAt) < Date.parse(fact.startedAt) ||
        Date.parse(fact.finishedAt) > Date.parse(occurredAt) ||
        fact.effortSeconds >
          (Date.parse(fact.finishedAt) - Date.parse(fact.startedAt)) / 1000)
    )
      reject('Repair times or effort are inconsistent');
  },
);

export const learningEventSchema = learningCommandBase.extend({
  sequence: z.number().int().positive(),
  actorId: z.string(),
  recordedAt: z.string().datetime(),
});

export const resolutionRunSchema = startResolutionRunSchema.extend({
  schemaVersion: z.literal(1),
  incidentId: z.string().uuid(),
  actorId: z.string(),
  createdAt: z.string().datetime(),
  context: z.object({
    evidenceRefs: z.array(z.string()),
    mappingVersions: z.array(z.string()),
    configVersion: z.string(),
    ruleVersion: z.string(),
    diagnosisVersion: z.string(),
    hypotheses: z.array(
      z.object({
        code: z.string(),
        text: z.string(),
        evidenceRefs: z.array(z.string()),
        contradictingEvidenceRefs: z.array(z.string()),
        uncertainty: z.literal('unsubstantiated'),
        missingChecks: z.array(z.string()),
        origin: z.enum(['rule', 'model']),
      }),
    ),
    model: z.object({
      status: z.enum(['disabled', 'used', 'unavailable', 'rejected']),
      model: z.string().nullable(),
      promptVersion: z.string().nullable(),
    }),
  }),
  generation: z.object({
    kind: z.enum(['manual', 'generated']),
    reference: z.string(),
  }),
  artifactDigest: hash,
});

export const resolutionHistorySchema = z.object({
  run: resolutionRunSchema,
  events: z.array(learningEventSchema),
  steps: z.array(z.record(z.string(), z.unknown())),
  executions: z.array(z.record(z.string(), z.unknown())),
  verifications: z.array(z.record(z.string(), z.unknown())),
  failures: z.array(z.record(z.string(), z.unknown())),
  incident: z.record(z.string(), z.unknown()),
  incidentVerifications: z.array(z.record(z.string(), z.unknown())),
  recurrences: z.array(
    z.object({ id: z.string().uuid(), detectedAt: z.string().datetime() }),
  ),
});
