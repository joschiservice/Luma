import { codeOwnedSteps } from './code-grants.js';
import type { CodeTelemetry } from './code-step.js';
import type { DraftStep, WorkflowDraftContent } from './draft.js';
import type { PlaybookFields, PlaybookScalar } from './playbook.js';
import type {
  ProcessRunState,
  ProcessStep,
  ProcessStepOutput,
  ProcessWorkflowVersion,
} from './process.js';

/** The example reply a step receives in a test instead of calling a connected system. */
export type StepReply =
  | { kind: 'read'; values: Record<string, PlaybookScalar> }
  | { kind: 'approval'; decision: 'approved' | 'denied' | 'pending' }
  | {
      kind: 'capability';
      result: 'accepted' | 'approval_required' | 'denied';
    }
  | {
      kind: 'verification';
      state: 'verified' | 'failed' | 'inconclusive';
      values: Record<string, PlaybookScalar>;
    };

/** Where a test run stopped. `awaiting_decision` means the workflow would wait for a person. */
export type TestOutcome = Exclude<ProcessRunState, 'running' | 'waiting'>;

/** Example data for one test of a draft. Replies are keyed by step ID. */
export interface DraftTestCase {
  id: string;
  name: string;
  inputs: Record<string, PlaybookScalar>;
  /** Context facts the run starts with. */
  evidence: Record<string, PlaybookScalar>;
  replies: Record<string, StepReply>;
  /** Expected final outcome; null means the case only records what happened. */
  expected: { outcome: TestOutcome } | null;
}

/** What one step did in a test run, described for the workflow's author. */
export interface TestStepResult {
  stepId: string;
  kind: ProcessStep['kind'];
  title: string;
  /** Last recorded state for the step. */
  state: ProcessStepOutput['state'];
  /** Values the step used, such as an action's resolved values or a condition's observed field. */
  inputs: Record<string, PlaybookScalar>;
  outputs: Record<string, PlaybookScalar>;
  /** What the workflow did after this step. Null for steps a Code Step requested. */
  branch: 'continued' | 'ended' | 'escalated' | 'paused' | 'denied' | null;
  note: string;
  code?: CodeTelemetry;
}

/** The outcome of one test run and each step it reached, in order. */
export interface DraftTestResult {
  outcome: TestOutcome;
  stoppedAt: string | null;
  /** Plain-language explanation of the outcome. */
  reason: string | null;
  /** Whether the outcome matched the case's expectation; null when the case has none. */
  passed: boolean | null;
  steps: TestStepResult[];
}

/** A test run of one draft revision. Runs belong to the person who started them. */
export interface DraftTestRun {
  id: string;
  draftId: string;
  revision: number;
  /** The saved case this run tested, or null for an unsaved case. */
  caseId: string | null;
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  expiresAt: string;
  result: DraftTestResult | null;
  /** Plain-language reason when the run could not complete, e.g. sandbox unavailable or limit reached. */
  error: string | null;
}

/** A named example an installed adapter offers for drafts that use its steps. */
export interface TestScenario {
  id: string;
  name: string;
  description: string;
  case: DraftTestCase;
}

/** A reason a case cannot run against a draft, on the step and field to change. */
export interface TestCaseProblem {
  stepId: string | null;
  field: string | null;
  message: string;
}

/** A step a Code Step requested during a test, with the example reply it received. */
export interface CodeRequestExample {
  stepId: string;
  state: ProcessStepOutput['state'];
  values: Record<string, PlaybookScalar>;
}

type FieldType = PlaybookFields[string];

const emptyValues: Record<FieldType, PlaybookScalar> = {
  string: '',
  number: 0,
  boolean: false,
  null: null,
};

const typeNames: Record<FieldType, string> = {
  string: 'text',
  number: 'a number',
  boolean: 'yes or no',
  null: 'empty',
};

const replyLabels: Record<StepReply['kind'], string> = {
  read: 'a data',
  approval: 'an approval',
  capability: 'an action',
  verification: 'a result check',
};

const typeOf = (value: PlaybookScalar): FieldType =>
  value === null ? 'null' : (typeof value as FieldType);

function checkValues(
  declared: PlaybookFields,
  values: Record<string, PlaybookScalar>,
  stepId: string | null,
  group: string,
): TestCaseProblem[] {
  const problems: TestCaseProblem[] = [];
  for (const [name, type] of Object.entries(declared)) {
    if (!Object.hasOwn(values, name))
      problems.push({
        stepId,
        field: `${group}.${name}`,
        message: `Enter an example value for “${name}”.`,
      });
    else if (typeOf(values[name]!) !== type)
      problems.push({
        stepId,
        field: `${group}.${name}`,
        message: `“${name}” must be ${typeNames[type]}.`,
      });
  }
  for (const name of Object.keys(values))
    if (!Object.hasOwn(declared, name))
      problems.push({
        stepId,
        field: `${group}.${name}`,
        message: `Remove “${name}”. It isn't a declared field.`,
      });

  return problems;
}

/**
 * Checks a case against a compiled draft. Inputs, evidence and read or result-check values must
 * match the declared fields exactly. Every read the workflow performs itself, every action and
 * every result check of an accepted action needs a reply. A missing approval reply means nobody
 * has decided yet, so the run pauses there. Reads a Code Step requests may be left out; the
 * request is then denied.
 */
export function checkTestCase(
  version: Pick<ProcessWorkflowVersion, 'inputs' | 'context' | 'steps'>,
  testCase: DraftTestCase,
): TestCaseProblem[] {
  const problems: TestCaseProblem[] = [];
  if (!testCase.name.trim())
    problems.push({
      stepId: null,
      field: 'name',
      message: 'Name this test case.',
    });
  problems.push(
    ...checkValues(version.inputs, testCase.inputs, null, 'inputs'),
    ...checkValues(version.context.fields, testCase.evidence, null, 'evidence'),
  );
  for (const [stepId, reply] of Object.entries(testCase.replies)) {
    const step = version.steps.find((item) => item.id === stepId);
    if (!step)
      problems.push({
        stepId,
        field: null,
        message: `This workflow has no step “${stepId}”. Remove its example reply.`,
      });
    else if (step.kind !== reply.kind)
      problems.push({
        stepId,
        field: null,
        message: Object.hasOwn(replyLabels, step.kind)
          ? `“${stepId}” needs ${replyLabels[step.kind as StepReply['kind']]} reply.`
          : `“${stepId}” doesn't take an example reply. Remove it.`,
      });
    else if (
      (reply.kind === 'read' && step.kind === 'read') ||
      (reply.kind === 'verification' && step.kind === 'verification')
    )
      problems.push(
        ...checkValues(step.fields, reply.values, stepId, 'values'),
      );
  }
  const owned = codeOwnedSteps(version);
  for (const step of version.steps) {
    if (Object.hasOwn(testCase.replies, step.id)) continue;
    let message: string | null = null;
    if (step.kind === 'read' && !owned.has(step.id))
      message = 'Give an example reply for this read.';
    else if (step.kind === 'capability')
      message = 'Choose what happens when this action is requested.';
    else if (step.kind === 'verification') {
      const action = testCase.replies[step.forStep];
      if (action?.kind === 'capability' && action.result === 'accepted')
        message = 'Give an example result for this check.';
    }
    if (message) problems.push({ stepId: step.id, field: null, message });
  }

  return problems;
}

function fill(fields: PlaybookFields): Record<string, PlaybookScalar> {
  return Object.fromEntries(
    Object.entries(fields).map(([name, type]) => [name, emptyValues[type]]),
  );
}

/**
 * Builds a case from declared fields: empty text, 0, no or empty values; approvals approved,
 * actions accepted and result checks verified.
 */
export function defaultCase(
  content: Pick<WorkflowDraftContent, 'inputs' | 'context' | 'steps'>,
  id: string,
  name = 'Example',
): DraftTestCase {
  const replies: Record<string, StepReply> = {};
  for (const step of content.steps) {
    if (step.kind === 'read')
      replies[step.id] = { kind: 'read', values: fill(step.fields) };
    else if (step.kind === 'approval')
      replies[step.id] = { kind: 'approval', decision: 'approved' };
    else if (step.kind === 'capability')
      replies[step.id] = { kind: 'capability', result: 'accepted' };
    else if (step.kind === 'verification')
      replies[step.id] = {
        kind: 'verification',
        state: 'verified',
        values: fill(step.fields),
      };
  }

  return {
    id,
    name,
    inputs: fill(content.inputs),
    evidence: fill(content.context.fields),
    replies,
    expected: null,
  };
}

/**
 * Whether a draft step does the same work as a reference step: the same kind and ID, or the same
 * read source, action or result check.
 */
export function sameStep(
  step: DraftStep | ProcessStep,
  reference: DraftStep | ProcessStep,
): boolean {
  if (step.kind !== reference.kind) return false;
  if (step.id === reference.id) return true;
  if (step.kind === 'read' && reference.kind === 'read')
    return step.source === reference.source;
  if (step.kind === 'capability' && reference.kind === 'capability')
    return (
      step.capability === reference.capability &&
      step.capabilityVersion === reference.capabilityVersion
    );
  if (step.kind === 'verification' && reference.kind === 'verification')
    return step.evaluatorVersion === reference.evaluatorVersion;

  return false;
}

/**
 * Applies example values recorded for another workflow to a draft. A reply keyed by the draft
 * step's own ID wins; otherwise a reference step that does the same work supplies it. Values
 * are kept when their name and type match a declared field; anything else keeps `base`.
 */
export function adaptCase(
  content: Pick<WorkflowDraftContent, 'inputs' | 'context' | 'steps'>,
  reference: { steps: (DraftStep | ProcessStep)[] } | null,
  example: Pick<DraftTestCase, 'inputs' | 'evidence' | 'replies'>,
  base: DraftTestCase,
): DraftTestCase {
  const fit = (
    declared: PlaybookFields,
    values: Record<string, PlaybookScalar>,
    fallback: Record<string, PlaybookScalar>,
  ) =>
    Object.fromEntries(
      Object.entries(declared).map(([name, type]) => [
        name,
        Object.hasOwn(values, name) && typeOf(values[name]!) === type
          ? values[name]!
          : Object.hasOwn(fallback, name)
            ? fallback[name]!
            : emptyValues[type],
      ]),
    );
  const replies = { ...base.replies };
  for (const step of content.steps) {
    const own = example.replies[step.id];
    const match =
      own?.kind === step.kind
        ? own
        : reference?.steps
            .filter((item) => sameStep(step, item))
            .map((item) => example.replies[item.id])
            .find((reply) => reply?.kind === step.kind);
    if (!match) continue;
    const previous = base.replies[step.id];
    const fallback = previous && 'values' in previous ? previous.values : {};
    if (match.kind === 'read' && step.kind === 'read')
      replies[step.id] = {
        kind: 'read',
        values: fit(step.fields, match.values, fallback),
      };
    else if (match.kind === 'verification' && step.kind === 'verification')
      replies[step.id] = {
        ...match,
        values: fit(step.fields, match.values, fallback),
      };
    else replies[step.id] = match;
  }

  return {
    ...base,
    inputs: fit(content.inputs, example.inputs, base.inputs),
    evidence: fit(content.context.fields, example.evidence, base.evidence),
    replies,
  };
}

/** Turns the recorded steps of a real run into example replies, keyed by the run's step IDs. */
export function repliesFromOutputs(
  outputs: ProcessStepOutput[],
): Record<string, StepReply> {
  const replies: Record<string, StepReply> = {};
  for (const output of outputs) {
    if (output.kind === 'read' && output.state === 'completed')
      replies[output.stepId] = { kind: 'read', values: output.values };
    else if (output.kind === 'approval')
      replies[output.stepId] = {
        kind: 'approval',
        decision:
          output.state === 'completed'
            ? 'approved'
            : output.state === 'denied'
              ? 'denied'
              : 'pending',
      };
    else if (output.kind === 'capability')
      replies[output.stepId] = {
        kind: 'capability',
        result:
          output.state === 'completed'
            ? 'accepted'
            : output.state === 'waiting'
              ? 'approval_required'
              : 'denied',
      };
    else if (
      output.kind === 'verification' &&
      ['completed', 'failed', 'inconclusive'].includes(output.state)
    )
      replies[output.stepId] = {
        kind: 'verification',
        state:
          output.state === 'completed'
            ? 'verified'
            : (output.state as 'failed' | 'inconclusive'),
        values: output.values,
      };
  }

  return replies;
}
