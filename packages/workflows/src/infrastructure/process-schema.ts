import { z } from 'zod';

import { codeOwnedSteps } from '../domain/code-grants.js';
import type { PlaybookSnapshot } from '../domain/playbook.js';
import type { ProcessWorkflowVersion } from '../domain/process.js';
import { compileCodeSource } from './code/compiler.js';
import { checkCodeStep, codeStepSchema } from './code/schema.js';
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
  codeStepSchema,
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
        kind: z.enum(['resolution', 'pilot', 'native']),
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
  const internal = codeOwnedSteps(contract);
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
    if (step.kind === 'read' && !internal.has(step.id))
      available.set(step.id, step.fields);
    if (step.kind === 'code') {
      checkCodeStep(step);
      compileCodeSource(step.source);
      available.set(step.id, step.fields);
    }
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
      // Policy approval is enforced by Action Admission; an explicit decision is optional.
      // A business process may create a resource different from its triggering subject.
      if (pendingApproval !== null && pendingApproval !== step.id)
        throw new Error('Approval must name its own action');
      pendingApproval = null;
      pendingVerification = step.id;
      for (const item of [
        ...Object.values(step.parameters),
        ...Object.values(step.expectedPostcondition),
      ]) {
        const owner = contract.steps.find(
          (candidate) =>
            candidate.kind === 'code' && candidate.grants.includes(step.id),
        );
        const grantedRead =
          item.source === 'step' &&
          owner?.kind === 'code' &&
          owner.grants.includes(item.stepId)
            ? contract.steps
                .slice(0, index)
                .find(
                  (candidate) =>
                    candidate.id === item.stepId && candidate.kind === 'read',
                )
            : undefined;
        if (
          item.source === 'step' &&
          !available.get(item.stepId)?.[item.field] &&
          !(grantedRead?.kind === 'read' && grantedRead.fields[item.field])
        )
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
  const owned = new Set<string>();
  for (const [index, step] of contract.steps.entries()) {
    if (step.kind !== 'code') continue;
    let next = index + 1;
    for (const grant of step.grants) {
      const node = contract.steps[next];
      if (
        !node ||
        node.id !== grant ||
        !['read', 'capability'].includes(node.kind) ||
        owned.has(grant)
      )
        throw new Error(
          'Code grants must name the immediately following read or action nodes',
        );
      owned.add(grant);
      next += node.kind === 'capability' ? 2 : 1;
      if (
        node.kind === 'capability' &&
        [
          ...Object.values(node.parameters),
          ...Object.values(node.expectedPostcondition),
        ].some((value) => value.source === 'step' && value.stepId === step.id)
      )
        throw new Error(
          'A code capability cannot depend on the unfinished code output',
        );
    }
  }
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
