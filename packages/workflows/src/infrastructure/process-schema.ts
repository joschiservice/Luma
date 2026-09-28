import { z, type ZodIssue } from 'zod';

import { codeOwnedSteps } from '../domain/code-grants.js';
import { codeRuntime, type CodeStep } from '../domain/code-step.js';
import {
  diagnostic,
  type WorkflowDiagnostic,
  type WorkflowDraftContent,
} from '../domain/draft.js';
import type { PlaybookSnapshot } from '../domain/playbook.js';
import type { ProcessStep, ProcessWorkflowVersion } from '../domain/process.js';
import { compileCodeSource } from './code/compiler.js';
import {
  checkCodeStep,
  codeArtifactDigest,
  codeStepSchema,
} from './code/schema.js';
import { playbookHash, snapshotSchema } from './playbooks/schema.js';

export { draftFromVersion } from '../domain/draft.js';

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
const plainSteps = [
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
        'Describe at least one expected result.',
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
] as const;
const steps = z.discriminatedUnion('kind', [codeStepSchema, ...plainSteps]);
const draftSteps = z.discriminatedUnion('kind', [
  codeStepSchema.omit({ artifactDigest: true, runtime: true }),
  ...plainSteps,
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
const contentShape = {
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
};
const provenance = z
  .object({
    kind: z.enum(['resolution', 'pilot', 'native']),
    reference: text,
    authoredBy: text,
    evidenceRefs: z.array(text).min(1).max(100),
    authoring: z
      .object({
        mode: z.enum(['template', 'visual', 'code', 'language']),
        draftId: z.string().uuid(),
        revision: z.number().int().positive(),
        notes: z.string().max(2000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const source = z
  .object({
    ...contentShape,
    steps: z.array(steps).min(2).max(32),
    provenance,
  })
  .strict();
const draftSource = z
  .object({ ...contentShape, steps: z.array(draftSteps).min(2).max(32) })
  .strict();
const envelope = source.extend({
  format: z.literal('workflow/2').optional(),
  digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

type ProcessSource = z.infer<typeof source>;

// Saved drafts only need a readable shape. Empty or incomplete values are reported by validation.
const looseText = z.string().max(2000);
const looseKey = z.string().max(80);
const looseFields = z
  .record(looseKey, z.enum(['string', 'number', 'boolean', 'null']))
  .refine((items) => Object.keys(items).length <= 64);
const looseValues = z
  .record(
    looseKey,
    z.discriminatedUnion('source', [
      z.object({ source: z.literal('input'), field: looseKey }).strict(),
      z.object({ source: z.literal('evidence'), field: looseKey }).strict(),
      z.object({ source: z.literal('literal'), value: scalar }).strict(),
      z
        .object({
          source: z.literal('step'),
          stepId: looseKey,
          field: looseKey,
        })
        .strict(),
    ]),
  )
  .refine((items) => Object.keys(items).length <= 64);
const looseNumber = z.number().finite();
const looseBase = z.object({ id: looseKey });
const looseStep = z.discriminatedUnion('kind', [
  looseBase
    .extend({
      kind: z.literal('code'),
      source: z.string().max(32768),
      fields: looseFields,
      grants: z.array(looseKey).max(16),
      limits: z
        .object({
          fuel: looseNumber,
          memoryBytes: looseNumber,
          wallTimeMs: looseNumber,
          maxRequests: looseNumber,
        })
        .strict(),
    })
    .strict(),
  looseBase
    .extend({ kind: z.literal('read'), source: looseText, fields: looseFields })
    .strict(),
  looseBase
    .extend({
      kind: z.literal('condition'),
      field: looseKey,
      equals: scalar,
      onFalse: z.enum(['escalate', 'end']),
    })
    .strict(),
  looseBase
    .extend({
      kind: z.literal('capability'),
      capability: looseText,
      capabilityVersion: looseText,
      targetKind: looseText,
      minimumRisk: z.enum(['low', 'medium', 'high']),
      parameters: looseValues,
      expectedPostcondition: looseValues,
    })
    .strict(),
  looseBase
    .extend({
      kind: z.literal('approval'),
      forStep: looseKey,
      expiresAfterSeconds: looseNumber,
    })
    .strict(),
  looseBase.extend({ kind: z.literal('wait'), seconds: looseNumber }).strict(),
  looseBase
    .extend({
      kind: z.literal('verification'),
      forStep: looseKey,
      evaluatorVersion: looseText,
      maxDurationSeconds: looseNumber,
      fields: looseFields,
    })
    .strict(),
  looseBase
    .extend({ kind: z.literal('escalation'), reason: looseText })
    .strict(),
  looseBase.extend({ kind: z.literal('end'), outcome: looseText }).strict(),
]);
const looseDraft = z
  .object({
    schemaVersion: z.literal(2),
    definition: z
      .object({
        id: looseKey,
        name: looseText,
        intent: looseText,
        category: looseText,
      })
      .strict(),
    version: looseText,
    applicability: z
      .object({
        trigger: z.discriminatedUnion('kind', [
          z
            .object({ kind: z.literal('exception'), issueType: looseText })
            .strict(),
          z.object({ kind: z.literal('manual') }).strict(),
          z.object({ kind: z.literal('event'), eventType: looseText }).strict(),
          z.object({ kind: z.literal('schedule'), at: looseText }).strict(),
          z
            .object({
              kind: z.literal('condition'),
              field: looseKey,
              equals: scalar,
            })
            .strict(),
        ]),
        subjectKind: looseText,
      })
      .strict(),
    inputs: looseFields,
    context: z
      .object({
        kind: looseText,
        fields: looseFields,
        maxAgeSeconds: looseNumber,
      })
      .strict(),
    steps: z.array(looseStep).max(32),
  })
  .strict();

/**
 * Reads saved draft content. Values may be empty or incomplete; only the structure must match
 * `workflow/2`. Returns diagnostics instead of content when the structure is unreadable.
 */
export function parseDraftShape(
  input: unknown,
):
  | { content: WorkflowDraftContent; diagnostics: [] }
  | { content: null; diagnostics: WorkflowDiagnostic[] } {
  const parsed = looseDraft.safeParse(input);
  if (!parsed.success)
    return {
      content: null,
      diagnostics: parsed.error.issues.map((issue) =>
        issueDiagnostic(issue, input),
      ),
    };

  return { content: parsed.data as WorkflowDraftContent, diagnostics: [] };
}

const labels: Record<string, string> = {
  id: 'Step ID',
  name: 'Name',
  intent: 'Description',
  category: 'Category',
  version: 'Version',
  kind: 'Step type',
  source: 'Source',
  field: 'Field',
  equals: 'Value',
  onFalse: 'What happens otherwise',
  capability: 'Action',
  capabilityVersion: 'Action version',
  targetKind: 'Changed record',
  minimumRisk: 'Risk',
  parameters: 'Action values',
  expectedPostcondition: 'Expected result',
  forStep: 'Step',
  expiresAfterSeconds: 'Approval time limit',
  seconds: 'Wait time',
  evaluatorVersion: 'Result check',
  maxDurationSeconds: 'Check time limit',
  fields: 'Fields',
  reason: 'Reason',
  outcome: 'Outcome',
  grants: 'Granted steps',
  limits: 'Limits',
  subjectKind: 'Subject',
  maxAgeSeconds: 'Maximum evidence age',
  steps: 'Steps',
};

/** Converts a schema issue into a plain-language diagnostic on the step and field it names. */
function issueDiagnostic(issue: ZodIssue, input: unknown): WorkflowDiagnostic {
  const path = issue.path.map(String);
  const stepIndex =
    path[0] === 'steps' && path.length > 1 ? Number(path[1]) : null;
  const rawStep =
    stepIndex === null
      ? undefined
      : (input as { steps?: unknown[] } | null)?.steps?.[stepIndex];
  const stepId =
    rawStep && typeof rawStep === 'object' && 'id' in rawStep
      ? String(rawStep.id)
      : null;
  const field = (stepIndex === null ? path : path.slice(2)).join('.') || null;
  const name = [...path]
    .reverse()
    .find((part) => Number.isNaN(Number(part)) && labels[part]);
  const label = name ? labels[name]! : 'This value';
  const last = path.at(-1) ?? '';
  let message: string;
  if (issue.code === 'invalid_type' && issue.received === 'undefined')
    message = `${label} is required.`;
  else if (issue.code === 'invalid_union_discriminator')
    message =
      last === 'kind'
        ? 'Choose a supported step type.'
        : `Choose a ${label.toLowerCase()}.`;
  else if (issue.code === 'invalid_enum_value')
    message = `Choose one of: ${issue.options.join(', ')}.`;
  else if (issue.code === 'unrecognized_keys')
    message = `Remove unsupported settings: ${issue.keys.join(', ')}.`;
  else if (issue.code === 'too_small')
    message =
      issue.type === 'string'
        ? `${label} can't be empty.`
        : issue.type === 'array'
          ? last === 'steps' || path.length === 1
            ? `Add at least ${issue.minimum} steps.`
            : `${label} needs at least ${issue.minimum} entries.`
          : `${label} must be at least ${issue.minimum}.`;
  else if (issue.code === 'too_big')
    message =
      issue.type === 'string'
        ? `${label} is too long.`
        : issue.type === 'array'
          ? `${label} can have at most ${issue.maximum} entries.`
          : `${label} must be at most ${issue.maximum}.`;
  else if (issue.code === 'invalid_string' && last === 'version')
    message = 'Use a version such as 1.0.0.';
  else if (issue.code === 'invalid_string' && issue.validation === 'datetime')
    message = 'Enter a valid date and time.';
  else if (issue.code === 'invalid_string')
    message =
      'Start with a lowercase letter and use only letters, numbers, - or _.';
  else if (issue.code === 'custom') message = issue.message;
  else message = `${label} has an invalid value.`;

  return diagnostic(
    `schema_${issue.code}`,
    message,
    `${path.join('.') || 'workflow'}: ${issue.message}`,
    { stepIndex, stepId, field },
  );
}

/** Applies the forward-only process rules to schema-valid content and reports every violation. */
function processRules(contract: ProcessSource): WorkflowDiagnostic[] {
  const found: WorkflowDiagnostic[] = [];
  const add = (
    code: string,
    message: string,
    detail: string,
    stepIndex: number | null,
    field: string | null,
  ) =>
    found.push(
      diagnostic(code, message, detail, {
        stepIndex,
        stepId:
          stepIndex === null ? null : (contract.steps[stepIndex]?.id ?? null),
        field,
      }),
    );
  const ids = new Set<string>();
  let pendingApproval: { id: string; index: number } | null = null;
  let pendingVerification: { id: string; index: number } | null = null;
  let totalWait = 0;
  const available = new Map<string, Record<string, string>>();
  const internal = codeOwnedSteps(contract);
  const last = contract.steps.length - 1;
  for (const [index, step] of contract.steps.entries()) {
    if (ids.has(step.id))
      add(
        'duplicate_step',
        'Another step already uses this ID. Give each step a unique ID.',
        'Step IDs must be unique',
        index,
        'id',
      );
    ids.add(step.id);
    const terminal = step.kind === 'end' || step.kind === 'escalation';
    if (terminal && index !== last)
      add(
        'early_terminal',
        'Only the last step can finish or escalate. Move this step to the end.',
        'Only the final step may end or escalate a process',
        index,
        'kind',
      );
    if (!terminal && index === last)
      add(
        'missing_terminal',
        'End the workflow with a Finish or Escalate step.',
        'Only the final step may end or escalate a process',
        index,
        'kind',
      );
    if (pendingVerification && step.kind !== 'verification') {
      add(
        'missing_verification',
        'Add a Check the result step right after this action.',
        'Every action needs immediate verification',
        pendingVerification.index,
        null,
      );
      pendingVerification = null;
    }
    if (pendingApproval && step.kind !== 'capability') {
      add(
        'approval_not_before_action',
        'An approval must come right before the action it approves.',
        'Approval must immediately precede its action',
        pendingApproval.index,
        'forStep',
      );
      pendingApproval = null;
    }
    if (step.kind === 'read' && !internal.has(step.id))
      available.set(step.id, step.fields);
    if (step.kind === 'code') {
      if (new Set(step.grants).size !== step.grants.length)
        add(
          'code_grants_unique',
          'Grant each step only once.',
          'Code grants must be unique',
          index,
          'grants',
        );
      else
        try {
          checkCodeStep(step);
        } catch (error) {
          add(
            'code_artifact',
            'This Code Step changed after it was bound. Save it again to refresh its artifact.',
            error instanceof Error ? error.message : 'Code artifact is invalid',
            index,
            null,
          );
        }
      try {
        compileCodeSource(step.source);
      } catch (error) {
        add(
          'code_source',
          'Write a synchronous main(input, luma) function without imports, exports or async code.',
          error instanceof Error ? error.message : 'Code source is invalid',
          index,
          'source',
        );
      }
      available.set(step.id, step.fields);
    }
    if (step.kind === 'condition') {
      const expected = step.equals === null ? 'null' : typeof step.equals;
      const observed = [...available.values()]
        .reverse()
        .find((item) => item[step.field]);
      const actual =
        observed?.[step.field] ?? contract.context.fields[step.field];
      if (actual !== expected)
        add(
          'condition_field',
          actual
            ? `“${step.field}” is a ${actual}. Compare it with a ${actual} value.`
            : `“${step.field}” isn't available before this step. Choose an evidence field or an earlier output.`,
          'Condition must match a declared context field',
          index,
          actual ? 'equals' : 'field',
        );
    }
    if (step.kind === 'approval') pendingApproval = { id: step.forStep, index };
    if (step.kind === 'capability') {
      // Policy approval is enforced by Action Admission; an explicit decision is optional.
      // A business process may create a resource different from its triggering subject.
      if (pendingApproval !== null && pendingApproval.id !== step.id)
        add(
          'approval_target',
          'This approval must name the action right after it.',
          'Approval must name its own action',
          pendingApproval.index,
          'forStep',
        );
      pendingApproval = null;
      pendingVerification = { id: step.id, index };
      for (const [group, items] of [
        ['parameters', step.parameters],
        ['expectedPostcondition', step.expectedPostcondition],
      ] as const) {
        for (const [name, item] of Object.entries(items)) {
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
            add(
              'unavailable_output',
              `“${item.stepId}.${item.field}” isn't available before this step. Choose an earlier output.`,
              'Action references an undeclared step output',
              index,
              `${group}.${name}`,
            );
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
            add(
              'undeclared_field',
              `“${item.field}” isn't a declared ${item.source === 'input' ? 'input' : 'evidence field'}.`,
              'Action references an undeclared field',
              index,
              `${group}.${name}`,
            );
        }
      }
    }
    if (step.kind === 'verification') {
      if (pendingVerification?.id !== step.forStep)
        add(
          'verification_target',
          'A result check must come right after the action it checks and name that action.',
          'Verification must immediately follow its action',
          index,
          'forStep',
        );
      pendingVerification = null;
    }
    if (step.kind === 'wait') totalWait += step.seconds;
  }
  if (pendingVerification)
    add(
      'missing_verification',
      'Add a Check the result step right after this action.',
      'Every action needs immediate verification',
      pendingVerification.index,
      null,
    );
  if (pendingApproval)
    add(
      'approval_not_before_action',
      'An approval must come right before the action it approves.',
      'Approval must immediately precede its action',
      pendingApproval.index,
      'forStep',
    );
  if (totalWait > 604_800)
    add(
      'unbounded_wait',
      'Waits add up to more than 7 days. Shorten them.',
      'Process has an incomplete or unbounded step',
      null,
      'steps',
    );
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
      ) {
        add(
          'code_grants',
          'Granted steps must be the reads or actions directly after this Code Step, in order.',
          'Code grants must name the immediately following read or action nodes',
          index,
          'grants',
        );
        break;
      }
      owned.add(grant);
      next += node.kind === 'capability' ? 2 : 1;
      if (
        node.kind === 'capability' &&
        [
          ...Object.values(node.parameters),
          ...Object.values(node.expectedPostcondition),
        ].some((value) => value.source === 'step' && value.stepId === step.id)
      )
        add(
          'code_dependency',
          'An action this Code Step requests can’t use the Code Step’s own output.',
          'A code capability cannot depend on the unfinished code output',
          index,
          'grants',
        );
    }
  }
  if (contract.applicability.trigger.kind === 'condition') {
    const check = contract.applicability.trigger;
    if (
      contract.context.fields[check.field] !==
      (check.equals === null ? 'null' : typeof check.equals)
    )
      add(
        'trigger_field',
        'The start condition must compare an evidence field with a value of the same type.',
        'Trigger must match a declared context field',
        null,
        'applicability.trigger.field',
      );
  }

  return found;
}

/** Validates a version and returns every problem, keyed by step and field. Has no side effects. */
export function checkProcessWorkflow(input: unknown): {
  version: ProcessWorkflowVersion | null;
  diagnostics: WorkflowDiagnostic[];
} {
  const parsed = envelope.safeParse(input);
  if (!parsed.success)
    return {
      version: null,
      diagnostics: parsed.error.issues.map((issue) =>
        issueDiagnostic(issue, input),
      ),
    };
  const supplied = parsed.data.digest;
  // The digest covers the authored contract, not its format marker or digest.
  const contract = source.parse(
    Object.fromEntries(
      Object.entries(parsed.data).filter(
        ([name]) => name !== 'digest' && name !== 'format',
      ),
    ),
  );
  const diagnostics = processRules(contract);
  const digest = playbookHash(contract);
  if (supplied && supplied !== digest)
    diagnostics.push(
      diagnostic(
        'digest_mismatch',
        'This version changed after it was published.',
        'Workflow digest mismatch',
      ),
    );

  return {
    version: diagnostics.length
      ? null
      : { ...contract, digest, format: 'workflow/2' },
    diagnostics,
  };
}

/** Compiles a forward-only process and binds every instruction to an immutable digest. */
export function compileProcessWorkflow(input: unknown): ProcessWorkflowVersion {
  envelope.parse(input);
  const { version, diagnostics } = checkProcessWorkflow(input);
  if (!version) throw new Error(diagnostics[0]!.detail);

  return version;
}

/** Binds draft Code Steps to the pinned runtime and their artifact digests. */
function bindDraftSteps(
  steps: z.infer<typeof draftSource>['steps'],
): ProcessStep[] {
  return steps.map((step) => {
    if (step.kind !== 'code') return step;
    const contract: Omit<CodeStep, 'artifactDigest'> = {
      id: step.id,
      kind: 'code',
      source: step.source,
      runtime: codeRuntime,
      fields: step.fields,
      grants: step.grants,
      limits: step.limits,
    };

    return { ...contract, artifactDigest: codeArtifactDigest(contract) };
  });
}

/**
 * Checks draft content as it would be published with the given provenance. Code Steps are bound
 * to the current runtime, so the returned version is exactly what publication would store.
 */
export function checkDraftContent(
  input: unknown,
  provenance: ProcessWorkflowVersion['provenance'],
): {
  content: WorkflowDraftContent | null;
  version: ProcessWorkflowVersion | null;
  diagnostics: WorkflowDiagnostic[];
} {
  const parsed = draftSource.safeParse(input);
  if (!parsed.success)
    return {
      content: null,
      version: null,
      diagnostics: parsed.error.issues.map((issue) =>
        issueDiagnostic(issue, input),
      ),
    };
  const checked = checkProcessWorkflow({
    ...parsed.data,
    steps: bindDraftSteps(parsed.data.steps),
    provenance,
  });

  return { content: parsed.data, ...checked };
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
