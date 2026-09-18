import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ProposedAction } from '#modules/policies/index';
const text = z.string().min(1).max(200);
const refs = z.array(z.string().uuid()).min(1).max(100);
const fields = z
  .record(
    z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()]),
  )
  .refine((value) => Object.keys(value).length <= 50);
const schema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    capability: text,
    capabilityVersion: text,
    connectionId: z.string().uuid(),
    target: z.object({ kind: text, id: z.string().uuid() }).strict(),
    parameters: fields,
    preconditions: z
      .object({ evidenceRefs: refs, validUntil: z.string().datetime() })
      .strict(),
    expectedPostcondition: fields,
    risk: z.enum(['low', 'medium', 'high']),
    proposedBy: z
      .object({
        kind: z.enum(['user', 'service', 'agent', 'connector']),
        id: text,
        initiatingUserId: text.optional(),
        model: z
          .object({
            provider: text,
            name: text,
            version: text,
            promptVersion: text,
            runId: text,
          })
          .strict()
          .optional(),
      })
      .strict()
      .refine((actor) => actor.kind !== 'agent' || !!actor.model),
    expiresAt: z.string().datetime(),
  })
  .strict();
const verification = z
  .object({
    outcome: z.enum(['passed', 'failed', 'inconclusive']),
    observationRefs: refs,
    observedAt: z.string().datetime(),
    evaluatorVersion: text,
  })
  .strict();
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function parseAction(input: unknown) {
  const action = schema.parse(input) as ProposedAction;
  return {
    action: freeze(action),
    hash: createHash('sha256').update(canonical(action)).digest('hex'),
  };
}
export const parseVerification = (input: unknown) => verification.parse(input);
export const parseEvidence = (input: unknown) => refs.parse(input);
