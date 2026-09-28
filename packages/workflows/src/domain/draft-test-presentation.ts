import type { CodeTelemetry } from './code-step.js';
import {
  describeStep,
  duration,
  humanize,
  scalar,
} from './draft-presentation.js';
import type {
  CodeRequestExample,
  DraftTestCase,
  DraftTestResult,
  TestOutcome,
  TestStepResult,
} from './draft-test.js';
import type { PlaybookScalar } from './playbook.js';
import type {
  ProcessRun,
  ProcessStep,
  ProcessStepOutput,
  ProcessValue,
  ProcessWorkflowVersion,
} from './process.js';
import type { AuthoringVocabulary } from './vocabulary.js';

type Seen = Pick<ProcessStepOutput, 'stepId' | 'kind' | 'values'>;

const outcomeReasons: Record<TestOutcome, string> = {
  verified:
    'The workflow finished and its result check confirmed the expected result.',
  ended: 'The workflow finished without taking further action.',
  escalated: 'The workflow would hand the run to a person.',
  denied: 'An approval was denied, so the workflow stopped.',
  failed_verification:
    'The result check found a different result. A person would review the run.',
  inconclusive_verification:
    'The result check could not confirm the result. A person would review the run.',
  awaiting_decision:
    'The workflow would wait here for an owner or admin to decide.',
};

const stopBranches: Record<TestOutcome, TestStepResult['branch']> = {
  verified: 'ended',
  ended: 'ended',
  escalated: 'escalated',
  denied: 'denied',
  failed_verification: 'escalated',
  inconclusive_verification: 'escalated',
  awaiting_decision: 'paused',
};

const codeStops: Record<CodeTelemetry['outcome'], string> = {
  completed: 'The Code Step finished',
  code_error: 'The Code Step failed with an error',
  resource_limit: 'The Code Step reached its time, memory or computation limit',
  cancelled: 'The Code Step was stopped',
  invalid_output:
    'The Code Step returned values that don’t match its declared fields',
  capability_denied:
    'The Code Step asked for a step it may not use, or a requested action was not accepted',
  unavailable: 'The Code Step runtime was unavailable',
};

function describeValues(values: Record<string, PlaybookScalar>) {
  return Object.entries(values)
    .map(([name, value]) => `${humanize(name)} is ${scalar(value)}`)
    .join(', ');
}

function resolve(
  value: ProcessValue,
  run: Pick<ProcessRun, 'context'>,
  seen: Seen[],
): PlaybookScalar {
  if (value.source === 'literal') return value.value;
  if (value.source !== 'step')
    return (
      (value.source === 'input'
        ? run.context.inputs
        : run.context.evidence.facts)[value.field] ?? null
    );

  return (
    [...seen]
      .reverse()
      .find(
        (item) =>
          item.stepId === value.stepId &&
          Object.hasOwn(item.values, value.field),
      )?.values[value.field] ?? null
  );
}

function resolveAll(
  values: Record<string, ProcessValue>,
  run: Pick<ProcessRun, 'context'>,
  seen: Seen[],
) {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      resolve(value, run, seen),
    ]),
  );
}

/** Mirrors the interpreter: the latest read or Code Step output with the field, else evidence. */
function observed(
  field: string,
  run: Pick<ProcessRun, 'context'>,
  seen: Seen[],
): PlaybookScalar {
  const output = [...seen]
    .reverse()
    .find(
      (item) =>
        (item.kind === 'read' || item.kind === 'code') &&
        Object.hasOwn(item.values, field),
    );

  return output
    ? output.values[field]!
    : (run.context.evidence.facts[field] ?? null);
}

function stepInputs(
  step: ProcessStep,
  version: ProcessWorkflowVersion,
  run: Pick<ProcessRun, 'context'>,
  seen: Seen[],
): Record<string, PlaybookScalar> {
  switch (step.kind) {
    case 'condition':
      return { [step.field]: observed(step.field, run, seen) };
    case 'capability':
      return resolveAll(step.parameters, run, seen);
    case 'verification': {
      const action = version.steps.find((item) => item.id === step.forStep);

      return action?.kind === 'capability'
        ? resolveAll(action.expectedPostcondition, run, seen)
        : {};
    }
    case 'wait':
      return { seconds: step.seconds };
    default:
      return {};
  }
}

function capabilityNote(
  step: Extract<ProcessStep, { kind: 'capability' }>,
  state: ProcessStepOutput['state'],
  vocabulary: AuthoringVocabulary,
  requested: boolean,
) {
  const label =
    vocabulary.capabilities.find(
      (item) =>
        item.capability === step.capability &&
        item.version === step.capabilityVersion,
    )?.label ?? humanize(step.capability);
  const check = `Action Admission would check “${label}” against policy before it runs.`;
  if (state === 'completed') return `${check} In this example it was accepted.`;
  if (state === 'waiting')
    return requested
      ? `${check} In this example it needs approval.`
      : `${check} In this example it needs approval, so the workflow would wait here.`;

  return requested
    ? `${check} In this example it was not accepted.`
    : `${check} In this example it was denied, so the workflow escalated to a person.`;
}

function note(
  step: ProcessStep,
  output: Pick<ProcessStepOutput, 'state' | 'values' | 'code'>,
  inputs: Record<string, PlaybookScalar>,
  vocabulary: AuthoringVocabulary,
  requested: boolean,
): string {
  switch (step.kind) {
    case 'read': {
      const label =
        vocabulary.reads.find((item) => item.source === step.source)?.label ??
        'The data';
      const values = describeValues(output.values);

      return values
        ? `${label} in this example: ${values}.`
        : `${label} returned no values in this example.`;
    }
    case 'condition': {
      const value = `${humanize(step.field)} is ${scalar(inputs[step.field] ?? null)}`;
      if (output.state === 'completed')
        return `${value}, so the workflow continued.`;

      return `${value}, not ${scalar(step.equals)}, so the workflow ${
        output.state === 'ended' ? 'finished' : 'escalated to a person'
      }.`;
    }
    case 'approval':
      return output.state === 'completed'
        ? 'An owner or admin approved in this example.'
        : output.state === 'waiting'
          ? 'Would wait here for an owner or admin to approve.'
          : 'An owner or admin denied it in this example, so the workflow stopped.';
    case 'capability':
      return capabilityNote(step, output.state, vocabulary, requested);
    case 'verification': {
      const label =
        vocabulary.evaluators.find(
          (item) => item.version === step.evaluatorVersion,
        )?.label ?? 'The result check';
      const values = describeValues(output.values);
      if (output.state === 'completed')
        return `${label} confirmed the result in this example${values ? `: ${values}` : ''}.`;
      if (output.state === 'failed')
        return `${label} found a different result in this example${values ? `: ${values}` : ''}. A person would review the run.`;

      return `${label} couldn’t confirm the result in this example. A person would review the run.`;
    }
    case 'wait':
      return `Would wait ${duration(step.seconds)}. The test skips the wait.`;
    case 'escalation':
      return `Hands the run to a person: ${step.reason}.`;
    case 'end':
      return `Finishes with “${step.outcome}”.`;
    case 'code': {
      if (output.state === 'completed') {
        const values = describeValues(output.values);

        return values
          ? `Computed ${values} in the sandbox.`
          : 'Ran in the sandbox.';
      }
      if (output.state === 'waiting')
        return 'Requested an action that needs approval, so the workflow would wait here.';

      return `${codeStops[output.code?.outcome ?? 'code_error']}, so the workflow escalated to a person.`;
    }
  }
}

/**
 * Describes a finished or paused test run: each step the interpreter reached with its last
 * recorded state, the values it used and produced, and what the workflow did next. Steps a Code
 * Step requested follow that Code Step.
 */
export function presentTestResult(input: {
  version: ProcessWorkflowVersion;
  run: Pick<ProcessRun, 'context'>;
  outputs: ProcessStepOutput[];
  requests: ReadonlyMap<string, CodeRequestExample[]>;
  final: { state: TestOutcome; stepId: string | null };
  expected: DraftTestCase['expected'];
  vocabulary: AuthoringVocabulary;
}): DraftTestResult {
  const { version, run, vocabulary } = input;
  const find = (id: string) => version.steps.find((item) => item.id === id);
  const order: string[] = [];
  const latest = new Map<string, ProcessStepOutput>();
  const inputs = new Map<string, Record<string, PlaybookScalar>>();
  const before = new Map<string, Seen[]>();
  const seen: Seen[] = [];
  for (const output of input.outputs) {
    const step = find(output.stepId);
    if (!step) continue;
    if (!latest.has(output.stepId)) {
      order.push(output.stepId);
      inputs.set(output.stepId, stepInputs(step, version, run, seen));
      before.set(output.stepId, [...seen]);
    }
    latest.set(output.stepId, output);
    seen.push(output);
  }

  const steps: TestStepResult[] = [];
  for (const [index, stepId] of order.entries()) {
    const step = find(stepId)!;
    const output = latest.get(stepId)!;
    const values = inputs.get(stepId)!;
    const stopped = index === order.length - 1 && input.final.stepId === stepId;
    steps.push({
      stepId,
      kind: step.kind,
      title: describeStep(step, vocabulary).title,
      state: output.state,
      inputs: values,
      outputs: output.values,
      branch: stopped ? stopBranches[input.final.state] : 'continued',
      note: note(step, output, values, vocabulary, false),
      ...(output.code ? { code: output.code } : {}),
    });
    if (step.kind !== 'code') continue;
    const requested: Seen[] = [...(before.get(stepId) ?? [])];
    for (const call of input.requests.get(stepId) ?? []) {
      const node = find(call.stepId);
      if (!node) continue;
      const callInputs = stepInputs(node, version, run, requested);
      steps.push({
        stepId: call.stepId,
        kind: node.kind,
        title: describeStep(node, vocabulary).title,
        state: call.state,
        inputs: callInputs,
        outputs: call.values,
        branch: null,
        note: `Requested by the Code Step. ${note(node, call, callInputs, vocabulary, true)}`,
      });
      requested.push({
        stepId: call.stepId,
        kind: node.kind,
        values: call.values,
      });
    }
  }

  return {
    outcome: input.final.state,
    stoppedAt: input.final.stepId,
    reason: outcomeReasons[input.final.state],
    passed: input.expected
      ? input.expected.outcome === input.final.state
      : null,
    steps,
  };
}
