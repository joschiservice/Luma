import { z } from 'zod';

import type { PlaybookSnapshot } from '../domain/playbook.js';
import type { ProcessWorkflowVersion } from '../domain/process.js';
import { playbookHash, snapshotSchema } from './playbooks/schema.js';

const key = z.string().regex(/^[a-z][a-zA-Z0-9_-]{0,79}$/);
const text = z.string().min(1).max(200);
const scalar = z.union([
  z.string().max(2000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const fields = z.record(key, z.enum(['string', 'number', 'boolean', 'null']));
const value = z.discriminatedUnion('source', [
  z.object({ source: z.literal('input'), field: key }).strict(),
  z.object({ source: z.literal('evidence'), field: key }).strict(),
  z.object({ source: z.literal('literal'), value: scalar }).strict(),
  z.object({ source: z.literal('step'), stepId: key, field: key }).strict(),
]);
const values = z.record(key, value);
const base = z.object({ id: key });
const steps = z.discriminatedUnion('kind', [
  base.extend({ kind: z.literal('read'), source: text, fields }).strict(),
  base
    .extend({
      kind: z.literal('condition'),
      field: key,
      equals: scalar,
      onFalse: z.enum(['escalate', 'end']),
    })
    .strict(),
  base
    .extend({
      kind: z.literal('capability'),
      capability: text,
      capabilityVersion: text,
      targetKind: text,
      minimumRisk: z.enum(['low', 'medium', 'high']),
      parameters: values,
      expectedPostcondition: values.refine(
        (items) => Object.keys(items).length > 0,
      ),
    })
    .strict(),
  base
    .extend({
      kind: z.literal('approval'),
      forStep: key,
      expiresAfterSeconds: z.number().int().min(1).max(86_400),
    })
    .strict(),
  base
    .extend({
      kind: z.literal('wait'),
      seconds: z.number().int().min(1).max(86_400),
    })
    .strict(),
  base
    .extend({
      kind: z.literal('verification'),
      forStep: key,
      evaluatorVersion: text,
      maxDurationSeconds: z.number().int().min(1).max(300),
      fields,
    })
    .strict(),
  base.extend({ kind: z.literal('escalation'), reason: text }).strict(),
  base.extend({ kind: z.literal('end'), outcome: text }).strict(),
]);
const trigger = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exception'), issueType: text }).strict(),
  z.object({ kind: z.literal('manual') }).strict(),
  z.object({ kind: z.literal('event'), eventType: text }).strict(),
  z.object({ kind: z.literal('schedule'), at: z.string().datetime() }).strict(),
  z
    .object({ kind: z.literal('condition'), field: key, equals: scalar })
    .strict(),
]);
const source = z
  .object({
    schemaVersion: z.literal(2),
    definition: z
      .object({
        id: key,
        name: text,
        intent: z.string().min(1).max(2000),
        category: text,
      })
      .strict(),
    version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
    applicability: z.object({ trigger, subjectKind: text }).strict(),
    inputs: fields,
    context: z
      .object({
        kind: text,
        fields,
        maxAgeSeconds: z.number().int().min(1).max(300),
      })
      .strict(),
    steps: z.array(steps).min(2).max(32),
    provenance: z
      .object({
        kind: z.enum(['resolution', 'pilot']),
        reference: text,
        authoredBy: text,
        evidenceRefs: z.array(text).min(1).max(100),
      })
      .strict(),
  })
  .strict();

/** Compiles a forward-only process and binds every instruction to an immutable digest. */
export function compileProcessWorkflow(input: unknown): ProcessWorkflowVersion {
  const envelope = source
    .extend({
      format: z.literal('workflow/2').optional(),
      digest: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .parse(input);
  const supplied = envelope.digest;
  const contract = source.parse(
    Object.fromEntries(
      Object.entries(envelope).filter(
        ([name]) => name !== 'digest' && name !== 'format',
      ),
    ),
  );
  const ids = new Set<string>();
  let pendingApproval: string | null = null;
  let pendingVerification: string | null = null;
  let totalWait = 0;
  const available = new Map<string, Record<string, string>>();
  for (const [index, step] of contract.steps.entries()) {
    if (ids.has(step.id)) throw new Error('Step IDs must be unique');
    ids.add(step.id);
    if (
      (step.kind === 'end' || step.kind === 'escalation') !==
      (index === contract.steps.length - 1)
    )
      throw new Error('Only the final step may end or escalate a process');
    if (pendingVerification && step.kind !== 'verification')
      throw new Error('Every action needs immediate verification');
    if (pendingApproval && step.kind !== 'capability')
      throw new Error('Approval must immediately precede its action');
    if (step.kind === 'read') available.set(step.id, step.fields);
    if (step.kind === 'condition') {
      const expected = step.equals === null ? 'null' : typeof step.equals;
      const observed = [...available.values()]
        .reverse()
        .find((item) => item[step.field]);
      if (
        (observed?.[step.field] ?? contract.context.fields[step.field]) !==
        expected
      )
        throw new Error('Condition must match a declared context field');
    }
    if (step.kind === 'approval') pendingApproval = step.forStep;
    if (step.kind === 'capability') {
      if (
        pendingApproval !== step.id ||
        step.targetKind !== contract.applicability.subjectKind
      )
        throw new Error(
          'Every action needs its own approval and matching subject',
        );
      pendingApproval = null;
      pendingVerification = step.id;
      for (const item of [
        ...Object.values(step.parameters),
        ...Object.values(step.expectedPostcondition),
      ]) {
        if (item.source === 'step' && !available.get(item.stepId)?.[item.field])
          throw new Error('Action references an undeclared step output');
        if (
          item.source !== 'literal' &&
          item.source !== 'step' &&
          !(
            item.field in
            (item.source === 'input'
              ? contract.inputs
              : contract.context.fields)
          )
        )
          throw new Error('Action references an undeclared field');
      }
    }
    if (step.kind === 'verification') {
      if (pendingVerification !== step.forStep)
        throw new Error('Verification must immediately follow its action');
      pendingVerification = null;
    }
    if (step.kind === 'wait') totalWait += step.seconds;
  }
  if (pendingApproval || pendingVerification || totalWait > 604_800)
    throw new Error('Process has an incomplete or unbounded step');
  if (contract.applicability.trigger.kind === 'condition') {
    const check = contract.applicability.trigger;
    if (
      contract.context.fields[check.field] !==
      (check.equals === null ? 'null' : typeof check.equals)
    )
      throw new Error('Trigger must match a declared context field');
  }
  const digest = playbookHash(contract);
  if (supplied && supplied !== digest)
    throw new Error('Workflow digest mismatch');

  return { ...contract, digest, format: 'workflow/2' };
}

/** Checks trigger inputs against the exact process version before creating a run. */
export function parseProcessSnapshot(
  input: unknown,
  version: ProcessWorkflowVersion,
): PlaybookSnapshot {
  const snapshot = snapshotSchema.parse(input);
  if (snapshot.evidence.kind !== version.context.kind)
    throw new Error('Evidence kind mismatch');
  for (const [declared, actual] of [
    [version.inputs, snapshot.inputs],
    [version.context.fields, snapshot.evidence.facts],
  ] as const) {
    if (
      Object.keys(declared).length !== Object.keys(actual).length ||
      Object.entries(declared).some(
        ([name, type]) =>
          !Object.hasOwn(actual, name) ||
          (actual[name] === null ? 'null' : typeof actual[name]) !== type,
      )
    )
      throw new Error('Snapshot fields do not match the workflow');
  }
  if (
    new Set(snapshot.evidence.observations.map((item) => item.id)).size !==
    snapshot.evidence.observations.length
  )
    throw new Error('Duplicate evidence observation');

  return snapshot;
}
