import { z } from 'zod';

const ref = z.string().min(1).max(512);

const text = z.string().min(1).max(2000);

const refs = z.array(ref).max(100);

const finding = z.object({ code: ref, text, evidenceRefs: refs }).strict();

export const evidenceReferenceSchema = z
  .object({
    id: ref,
    observedAt: z.string().datetime(),
    sourceUpdatedAt: z.string().datetime().nullable(),
    adapterVersion: ref,
    schemaVersion: z.number().int().positive(),
    source: z
      .object({
        provider: ref,
        resource: ref,
        externalId: ref,
        scopeKey: z.string(),
      })
      .strict()
      .nullable(),
  })
  .strict();

/** Persisted investigation. Attention and next steps are suggestions, not permission to act. */
export const diagnosisSchema = z
  .object({
    schemaVersion: z.literal(1),
    exceptionId: z.string().uuid(),
    revision: z.number().int().positive(),
    status: z.enum(['pending', 'ready', 'insufficient_evidence', 'failed']),
    reason: ref,
    superseded: z.boolean(),
    summary: text,
    detectorDecision: z.discriminatedUnion('decision', [
      z
        .object({
          decision: z.literal('detect'),
          severity: z.enum(['medium', 'high']),
          reason: ref,
        })
        .strict(),
      z
        .object({
          decision: z.enum(['clear', 'defer', 'reject']),
          severity: z.null(),
          reason: ref,
        })
        .strict(),
    ]),
    affected: z.object({ kind: ref, id: ref, scope: refs }).strict(),
    facts: z.array(finding).max(100),
    hypotheses: z
      .array(
        finding
          .extend({
            contradictingEvidenceRefs: refs,
            uncertainty: z.literal('unsubstantiated'),
            missingChecks: z.array(text).min(1).max(20),
            origin: z.enum(['rule', 'model']),
          })
          .strict(),
      )
      .max(20),
    constraints: z.array(text).max(100),
    impact: z
      .object({
        observed: z.array(finding),
        potential: z.array(finding),
        exposedQuantity: z
          .string()
          .regex(/^-?\d{1,15}(?:\.\d{1,6})?$/)
          .nullable(),
        unit: ref.nullable(),
        cost: z.null(),
      })
      .strict(),
    nextSteps: z
      .array(
        finding
          .extend({
            kind: z.enum(['read_investigate', 'manual_intervention']),
            preconditions: z.array(text),
            verificationCriteria: z.array(text).min(1),
            capabilityLimitations: z.array(text),
          })
          .strict(),
      )
      .max(20),
    attention: z
      .object({
        suggested: z.boolean(),
        reason: ref,
        evidenceRefs: refs,
        dueAt: z.string().datetime().nullable(),
      })
      .strict(),
    provenance: z
      .object({
        generatedAt: z.string().datetime(),
        engineVersion: ref,
        ruleVersion: ref,
        configVersion: ref,
        mappingVersions: refs,
        evidence: z.array(evidenceReferenceSchema).max(100),
        validUntil: z.string().datetime().nullable(),
        model: z
          .object({
            status: z.enum(['disabled', 'used', 'unavailable', 'rejected']),
            model: ref.nullable(),
            promptVersion: ref.nullable(),
          })
          .strict(),
        reread: z
          .object({
            status: z.enum([
              'not_requested',
              'unavailable',
              'completed',
              'rate_limited',
              'failed',
            ]),
            retryAfter: z.string().datetime().nullable(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set(value.provenance.evidence.map((e) => e.id));
    const referenced = [
      ...value.facts,
      ...value.hypotheses,
      ...value.impact.observed,
      ...value.impact.potential,
      ...value.nextSteps,
      value.attention,
    ].flatMap((f) => f.evidenceRefs);
    referenced.push(
      ...value.hypotheses.flatMap((h) => h.contradictingEvidenceRefs),
    );
    if (
      ids.size !== value.provenance.evidence.length ||
      referenced.some((id) => !ids.has(id))
    )
      context.addIssue({
        code: 'custom',
        message:
          'Evidence references must belong to the diagnosis evidence set.',
      });
  });

export type Diagnosis = z.infer<typeof diagnosisSchema>;
