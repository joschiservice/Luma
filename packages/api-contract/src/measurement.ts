import { z } from 'zod';

import { activityActorSchema } from './activity.js';

export const measurementEnvironmentSchema = z.enum([
  'live',
  'pilot',
  'synthetic',
  'shadow',
  'observe_only',
  'unknown',
]);
const time = z.string().datetime({ offset: true });
const refs = z.array(z.string().min(1).max(200)).min(1).max(50);
const code = z.string().min(1).max(100);

const measurementFactSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('environment'),
      environment: measurementEnvironmentSchema,
      evidenceRefs: refs,
    })
    .strict(),
  z
    .object({
      kind: z.literal('eligibility'),
      status: z.enum(['eligible', 'ineligible', 'unknown']),
      ruleVersion: code,
      reasonCode: code,
      evidenceRefs: refs,
    })
    .strict(),
  z
    .object({
      kind: z.literal('attribution'),
      involvement: z.enum([
        'none',
        'approval',
        'manual_repair',
        'operator_correction',
        'unknown',
      ]),
      complete: z.boolean(),
      from: time,
      through: time,
      evidenceRefs: refs,
    })
    .strict(),
  z
    .object({
      kind: z.literal('incorrect_action'),
      proposalId: z.string().uuid(),
      reasonCode: code,
      evidenceRefs: refs,
    })
    .strict(),
  z
    .object({
      kind: z.literal('baseline'),
      partnerReference: code,
      processVersion: code,
      sampleSize: z.number().int().min(1).max(1000000),
      measuredSeconds: z.number().positive().max(31536000),
      from: time,
      through: time,
      evidenceRefs: refs,
    })
    .strict(),
]);

export const measurementCommandSchema = z
  .object({
    id: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    fact: measurementFactSchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      'from' in v.fact &&
      Date.parse(v.fact.from) > Date.parse(v.fact.through)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'The coverage interval is reversed.',
      });
    if (
      v.fact.kind === 'baseline' &&
      v.fact.measuredSeconds >
        (Date.parse(v.fact.through) - Date.parse(v.fact.from)) / 1000
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Measured baseline exceeds its sample interval.',
      });
    if (
      v.fact.kind === 'attribution' &&
      v.fact.involvement === 'none' &&
      !v.fact.complete
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Absence of human work requires complete attribution.',
      });
  });

export const measurementEventSchema = z.object({
  id: z.string().uuid(),
  incidentId: z.string().uuid(),
  revision: z.number().int().positive(),
  schemaVersion: z.literal(1),
  actorId: z.string(),
  recordedAt: time,
  fact: measurementFactSchema,
});

export const measurementHistorySchema = z.object({
  items: z.array(measurementEventSchema),
  /** The people who recorded the listed facts. */
  people: z.array(activityActorSchema).max(100),
  nextRevision: z.number().int().nullable(),
  revision: z.number().int().nonnegative(),
});

export const resolutionMetricItemSchema = z.object({
  kind: z.literal('resolution'),
  id: z.string().uuid(),
  title: z.string(),
  state: z.string(),
  environment: measurementEnvironmentSchema,
  detectedAt: time,
  verifiedAt: time.nullable(),
  eligibility: z.enum(['eligible', 'ineligible', 'unknown']),
  involvement: z.enum(['none', 'human', 'unknown']),
  outcome: z.enum(['verified', 'pending', 'human_disposition']),
  timeToOutcomeSeconds: z.number().nonnegative().nullable(),
  unresolvedAgeSeconds: z.number().nonnegative().nullable(),
  previousIncidentId: z.string().uuid().nullable(),
  incorrectActionIds: z.array(z.string().uuid()),
  evidenceRefCount: z.number().int().nonnegative().optional(),
  factCount: z.number().int().nonnegative().optional(),
  evidenceRefs: z.array(z.string()).max(50),
  factIds: z.array(z.string().uuid()).max(50),
  revision: z.number().int().nonnegative(),
});

export type MeasurementCommand = z.infer<typeof measurementCommandSchema>;
