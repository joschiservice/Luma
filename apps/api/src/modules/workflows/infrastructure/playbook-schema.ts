import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  PlaybookVersion,
  PlaybookSnapshot,
} from '#modules/workflows/domain/playbook';

const text = z.string().min(1).max(200);
const key = z.string().regex(/^[a-z][a-zA-Z0-9_-]{0,79}$/);
const scalar = z.union([
  z.string().max(2000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const fields = z.record(key, z.enum(['string', 'number', 'boolean', 'null']));
const values = z.record(
  key,
  z.union([
    z.object({ source: z.enum(['input', 'evidence']), field: key }).strict(),
    z.object({ source: z.literal('literal'), value: scalar }).strict(),
  ]),
);
export const definitionSchema = z
  .object({ id: key, name: text, intent: z.string().min(1).max(2000) })
  .strict();
const irSchema = z
  .object({
    schemaVersion: z.literal(1),
    inputs: fields,
    evidence: z
      .object({
        kind: text,
        fields,
        maxAgeSeconds: z.number().int().min(1).max(300),
      })
      .strict(),
    eligibility: z
      .object({
        id: key,
        kind: z.literal('eligibility'),
        all: z
          .array(z.object({ field: key, equals: scalar }).strict())
          .min(1)
          .max(20),
      })
      .strict(),
    action: z
      .object({
        id: key,
        kind: z.literal('capability'),
        capability: text,
        capabilityVersion: text,
        targetKind: text,
        minimumRisk: z.enum(['low', 'medium', 'high']),
        parameters: values,
        expectedPostcondition: values.refine((v) => Object.keys(v).length > 0),
      })
      .strict(),
    approval: z
      .object({
        id: key,
        kind: z.literal('approval'),
        mode: z.enum(['policy', 'required']),
      })
      .strict(),
    verification: z
      .object({
        id: key,
        kind: z.literal('verification'),
        evaluatorVersion: text,
        maxDurationSeconds: z.number().int().min(1).max(300),
        maxAttempts: z.literal(1),
      })
      .strict(),
    recovery: z
      .object({
        id: key,
        kind: z.literal('escalation'),
        strategy: z.literal('reconcile_then_escalate'),
      })
      .strict(),
  })
  .strict()
  .superRefine((ir, ctx) => {
    const ids = [
      ir.eligibility,
      ir.action,
      ir.approval,
      ir.verification,
      ir.recovery,
    ].map((n) => n.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', message: 'Step IDs must be unique' });
    for (const check of ir.eligibility.all) {
      const type = check.equals === null ? 'null' : typeof check.equals;
      if (
        !Object.hasOwn(ir.evidence.fields, check.field) ||
        ir.evidence.fields[check.field] !== type
      )
        ctx.addIssue({
          code: 'custom',
          message:
            'Eligibility requires a declared evidence field of the same type',
        });
    }
    for (const value of [
      ...Object.values(ir.action.parameters),
      ...Object.values(ir.action.expectedPostcondition),
    ]) {
      if (
        value.source !== 'literal' &&
        !Object.hasOwn(
          value.source === 'input' ? ir.inputs : ir.evidence.fields,
          value.field,
        )
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Action references an undeclared field',
        });
    }
    if (ir.approval.mode === 'required' && ir.action.minimumRisk === 'low')
      ctx.addIssue({
        code: 'custom',
        message: 'Required approval needs medium or high minimum risk',
      });
  });
const sourceSchema = z
  .object({
    definition: definitionSchema,
    version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
    compatibility: z
      .object({
        interpreter: z.literal('resolution-playbook/0'),
        admission: z.literal(1),
      })
      .strict(),
    provenance: z
      .object({
        kind: z.enum(['resolution', 'pilot']),
        reference: text,
        authoredBy: text,
        evidenceRefs: z.array(text).min(1).max(100),
      })
      .strict(),
    ir: irSchema,
  })
  .strict();
export function canonicalPlaybook(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalPlaybook).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalPlaybook((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}
export const playbookHash = (value: unknown) =>
  createHash('sha256').update(canonicalPlaybook(value)).digest('hex');
export function definePlaybook(
  input: Omit<PlaybookVersion, 'digest'>,
): PlaybookVersion {
  return compilePlaybook(input);
}
export function compilePlaybook(input: unknown): PlaybookVersion {
  const parsed = sourceSchema.safeParse(input);
  if (!parsed.success)
    throw new Error('Unsupported playbook; escalate for author review', {
      cause: parsed.error,
    });
  const source = parsed.data;
  return { ...source, digest: playbookHash(source) };
}
/** Parse only the generated JSON literal. Never evaluate TypeScript or imports. */
export function parsePlaybookCode(code: string): PlaybookVersion {
  const prefix = 'export default definePlaybook(';
  if (!code.startsWith(prefix) || !code.endsWith(');\n'))
    throw new Error('Unsupported playbook code; escalate for author review');
  return compilePlaybook(JSON.parse(code.slice(prefix.length, -3)));
}
export function printPlaybookCode(version: PlaybookVersion): string {
  const { digest, ...source } = version;
  if (compilePlaybook(source).digest !== digest)
    throw new Error('Playbook digest mismatch');
  return `export default definePlaybook(${JSON.stringify(source, null, 2)});\n`;
}
export const activationRequestSchema = z
  .object({
    id: z.string().uuid(),
    definitionId: key,
    version: sourceSchema.shape.version,
    grants: z
      .object({
        principalIds: z.array(text).min(1).max(100),
        connectionIds: z.array(z.string().uuid()).min(1).max(100),
        targetIds: z.array(z.string().uuid()).min(1).max(100),
      })
      .strict(),
    policyVersion: text,
  })
  .strict();
export const snapshotSchema = z
  .object({
    inputs: z.record(key, scalar),
    evidence: z
      .object({
        kind: text,
        facts: z.record(key, scalar),
        observations: z
          .array(
            z
              .object({
                id: z.string().uuid(),
                observedAt: z.string().datetime(),
                source: text,
              })
              .strict(),
          )
          .min(1)
          .max(100),
      })
      .strict(),
    provenance: z
      .object({ reference: text, capturedAt: z.string().datetime() })
      .strict(),
  })
  .strict();
export function parsePlaybookSnapshot(
  input: unknown,
  version: PlaybookVersion,
): PlaybookSnapshot {
  const snapshot = snapshotSchema.parse(input);
  if (snapshot.evidence.kind !== version.ir.evidence.kind)
    throw new Error('Evidence kind mismatch');
  for (const [declared, actual] of [
    [version.ir.inputs, snapshot.inputs],
    [version.ir.evidence.fields, snapshot.evidence.facts],
  ] as const) {
    if (
      Object.keys(declared).length !== Object.keys(actual).length ||
      Object.entries(declared).some(
        ([key, type]) =>
          !Object.hasOwn(actual, key) ||
          (actual[key] === null ? 'null' : typeof actual[key]) !== type,
      )
    )
      throw new Error('Snapshot fields do not match the playbook');
  }
  if (
    new Set(snapshot.evidence.observations.map((o) => o.id)).size !==
    snapshot.evidence.observations.length
  )
    throw new Error('Duplicate evidence observation');
  return snapshot;
}
