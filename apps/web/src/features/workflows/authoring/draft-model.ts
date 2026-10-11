import type {
  AuthoringVocabulary,
  DraftStep,
  DraftValidation,
  ValueOption,
  WorkflowDiagnostic,
  WorkflowDraftContent,
} from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';

export type StepKind = DraftStep['kind'];

export type FieldType = 'string' | 'number' | 'boolean' | 'null';

export type StepValue = Extract<
  DraftStep,
  { kind: 'capability' }
>['parameters'][string];

const bases: Record<StepKind, string> = {
  read: 'read',
  condition: 'check',
  capability: 'action',
  approval: 'approval',
  wait: 'wait',
  human_task: 'task',
  event_wait: 'event',
  verification: 'verify',
  escalation: 'escalate',
  end: 'finish',
  code: 'compute',
};

/** Returns a step ID that no other step in the draft uses. */
export function uniqueStepId(content: WorkflowDraftContent, base: string) {
  const taken = new Set(content.steps.map((step) => step.id));
  const clean =
    base
      .toLowerCase()
      .replaceAll(/[^a-z0-9_-]+/g, '-')
      .replace(/^[^a-z]+/, '')
      .slice(0, 60) || 'step';
  if (!taken.has(clean)) return clean;
  for (let index = 2; ; index++)
    if (!taken.has(`${clean}-${index}`)) return `${clean}-${index}`;
}

/** The empty value an author starts from for a field of this type. */
export function emptyValue(type: FieldType) {
  return type === 'number'
    ? 0
    : type === 'boolean'
      ? false
      : type === 'null'
        ? null
        : '';
}

/**
 * Builds a new step of the given kind with sensible defaults. Actions come with the result check
 * that must follow them, so the returned list has one or two steps.
 */
export function createSteps(
  kind: StepKind,
  content: WorkflowDraftContent,
  vocabulary: AuthoringVocabulary,
  options: { capability?: string; source?: string } = {},
): DraftStep[] {
  const id = uniqueStepId(content, bases[kind]);
  switch (kind) {
    case 'read': {
      const source =
        vocabulary.reads.find((item) => item.source === options.source) ??
        vocabulary.reads[0];

      return [
        {
          id,
          kind,
          source: source?.source ?? '',
          fields: source ? { ...source.fields } : {},
        },
      ];
    }
    case 'condition':
      return [{ id, kind, field: '', equals: true, onFalse: 'end' }];
    case 'capability': {
      const entry =
        vocabulary.capabilities.find(
          (item) => `${item.capability}@${item.version}` === options.capability,
        ) ?? vocabulary.capabilities[0];
      const evaluator = vocabulary.evaluators.find(
        (item) => item.version === entry?.evaluators[0],
      );
      const action: DraftStep = {
        id,
        kind,
        capability: entry?.capability ?? '',
        capabilityVersion: entry?.version ?? '',
        targetKind: entry?.targetKind ?? '',
        minimumRisk: entry?.minimumRisk ?? 'medium',
        parameters: {},
        expectedPostcondition: Object.fromEntries(
          Object.entries(entry?.postcondition ?? {}).map(([name, type]) => [
            name,
            { source: 'literal' as const, value: emptyValue(type) },
          ]),
        ),
      };

      return [
        action,
        {
          id: uniqueStepId(
            { ...content, steps: [...content.steps, action] },
            `verify-${id}`,
          ),
          kind: 'verification',
          forStep: id,
          evaluatorVersion: evaluator?.version ?? '',
          maxDurationSeconds: 60,
          fields: evaluator ? { ...evaluator.fields } : {},
        },
      ];
    }
    case 'approval':
      return [{ id, kind, forStep: '', expiresAfterSeconds: 86_400 }];
    case 'human_task':
      return [
        {
          id,
          kind,
          assignee: { kind: 'role', key: 'member' },
          instructions: '',
          choices: ['Confirmed'],
          evidence: 'text',
          dueAfterSeconds: 86400,
          escalationTarget: { kind: 'role', key: 'admin' },
        },
      ];
    case 'event_wait':
      return [
        {
          id,
          kind,
          eventType: '',
          correlation: { source: 'literal', value: '' },
          fields: {},
          timeoutSeconds: 86400,
          onTimeout: 'escalate',
        },
      ];
    case 'wait':
      return [{ id, kind, seconds: 300 }];
    case 'verification':
      return [
        {
          id,
          kind,
          forStep: '',
          evaluatorVersion: '',
          maxDurationSeconds: 60,
          fields: {},
        },
      ];
    case 'escalation':
      return [{ id, kind, reason: '' }];
    case 'end':
      return [{ id, kind, outcome: 'Completed' }];
    case 'code':
      return [
        {
          id,
          kind,
          source: 'function main(input, luma) {\n  return { result: true };\n}',
          fields: { result: 'boolean' },
          grants: [],
          limits: { ...vocabulary.codeSteps.limits },
        },
      ];
  }
}

/** Inserts steps at a position. Approvals are linked to the action that follows them. */
export function insertSteps(
  content: WorkflowDraftContent,
  index: number,
  steps: DraftStep[],
): WorkflowDraftContent {
  const next = [...content.steps];
  next.splice(index, 0, ...steps);
  const linked = next.map((step, position) => {
    if (step.kind !== 'approval' || step.forStep) return step;
    const action = next[position + 1];

    return action?.kind === 'capability'
      ? { ...step, forStep: action.id }
      : step;
  });

  return { ...content, steps: linked };
}

/** Moves one step. The caller shows any reference the move breaks as a diagnostic. */
export function moveStep(
  content: WorkflowDraftContent,
  from: number,
  to: number,
): WorkflowDraftContent {
  if (to < 0 || to >= content.steps.length || from === to) return content;
  const next = [...content.steps];
  const [step] = next.splice(from, 1);
  next.splice(to, 0, step!);

  return { ...content, steps: next };
}

/** Removes one step. References to it stay visible as diagnostics until fixed. */
export function removeStep(
  content: WorkflowDraftContent,
  index: number,
): WorkflowDraftContent {
  return {
    ...content,
    steps: content.steps.filter((_, position) => position !== index),
  };
}

/** Replaces one step. */
export function updateStep(
  content: WorkflowDraftContent,
  index: number,
  step: DraftStep,
): WorkflowDraftContent {
  return {
    ...content,
    steps: content.steps.map((item, position) =>
      position === index ? step : item,
    ),
  };
}

/** Renames a step and every approval, check, grant and value that refers to it. */
export function renameStep(
  content: WorkflowDraftContent,
  from: string,
  to: string,
): WorkflowDraftContent {
  const values = (items: Record<string, StepValue>) =>
    Object.fromEntries(
      Object.entries(items).map(([name, value]) => [
        name,
        value.source === 'step' && value.stepId === from
          ? { ...value, stepId: to }
          : value,
      ]),
    );

  return {
    ...content,
    steps: content.steps.map((step): DraftStep => {
      const renamed = step.id === from ? { ...step, id: to } : step;
      switch (renamed.kind) {
        case 'approval':
        case 'verification':
          return renamed.forStep === from
            ? { ...renamed, forStep: to }
            : renamed;
        case 'capability':
          return {
            ...renamed,
            parameters: values(renamed.parameters),
            expectedPostcondition: values(renamed.expectedPostcondition),
          };
        case 'code':
          return {
            ...renamed,
            grants: renamed.grants.map((grant) =>
              grant === from ? to : grant,
            ),
          };
        default:
          return renamed;
      }
    }),
  };
}

/** Turns `belowMinimum` or `purchase_order` into readable words. */
export function humanize(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll(/[._-]+/g, ' ')
    .trim()
    .toLowerCase();
}

/** A stable key for a value source, used by pickers. */
export function valueKey(value: StepValue | ValueOption) {
  return value.source === 'literal'
    ? 'literal'
    : value.source === 'step'
      ? `step:${value.stepId}:${value.field}`
      : `${value.source}:${value.field}`;
}

/** Describes where a value comes from in plain words. */
export function valueLabel(value: StepValue | ValueOption) {
  if (value.source === 'literal')
    return 'value' in value
      ? JSON.stringify(value.value)
      : m.authoring_value_fixed();
  if (value.source === 'input')
    return m.authoring_value_input({ field: humanize(value.field) });
  if (value.source === 'evidence')
    return m.authoring_value_evidence({ field: humanize(value.field) });

  return m.authoring_value_step({
    step: value.stepId ?? '',
    field: humanize(value.field),
  });
}

/** Formats a whole number of seconds in the largest unit that divides it, such as “2 hours”. */
function formatDuration(seconds: number) {
  const [unit, size] =
    (
      [
        ['day', 86_400],
        ['hour', 3600],
        ['minute', 60],
      ] as const
    ).find(([, size]) => seconds >= size && seconds % size === 0) ??
    (['second', 1] as const);

  return formatNumber(seconds / size, {
    style: 'unit',
    unit,
    unitDisplay: 'long',
  });
}

const riskFacts = {
  low: m.authoring_fact_risk_low,
  medium: m.authoring_fact_risk_medium,
  high: m.authoring_fact_risk_high,
} satisfies Record<'low' | 'medium' | 'high', () => string>;

/** Returns diagnostics that belong to one step, or to the workflow when `index` is null. */
export function diagnosticsAt(
  validation: DraftValidation | undefined,
  index: number | null,
  field?: string,
): WorkflowDiagnostic[] {
  return (validation?.diagnostics ?? []).filter(
    (item) =>
      item.stepIndex === index &&
      (field === undefined ||
        item.field === field ||
        item.field?.startsWith(`${field}.`)),
  );
}

/** Where a new step lands by default: before the final Finish or Escalate step, else at the end. */
export function defaultInsertIndex(content: WorkflowDraftContent) {
  const last = content.steps.at(-1);

  return last && (last.kind === 'end' || last.kind === 'escalation')
    ? content.steps.length - 1
    : content.steps.length;
}

/** Copies a step with a new ID right after the original. */
export function duplicateStep(
  content: WorkflowDraftContent,
  index: number,
): WorkflowDraftContent {
  const step = content.steps[index];
  if (!step) return content;

  return insertSteps(content, index + 1, [
    { ...step, id: uniqueStepId(content, `${step.id}-copy`) },
  ]);
}

export type PaletteGroup = 'data' | 'decide' | 'act' | 'compute' | 'finish';

/** Something an author can drag into the workflow, with whether it can run here. */
export interface PaletteItem {
  key: string;
  kind: StepKind;
  group: PaletteGroup;
  label: string;
  description: string;
  executable: boolean;
  reason: string | null;
  options: { capability?: string; source?: string };
}

const groups: Record<StepKind, PaletteGroup> = {
  read: 'data',
  condition: 'decide',
  approval: 'decide',
  wait: 'decide',
  human_task: 'decide',
  event_wait: 'decide',
  capability: 'act',
  verification: 'act',
  code: 'compute',
  escalation: 'finish',
  end: 'finish',
};

/**
 * Lists palette entries from the workspace vocabulary. Installed data sources and actions appear
 * as ready-made steps; other step types appear once. Entries that can't run here stay listed.
 */
export function paletteItems(vocabulary: AuthoringVocabulary): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const kind of vocabulary.stepKinds) {
    if (kind.kind === 'read' && vocabulary.reads.length) {
      for (const source of vocabulary.reads)
        items.push({
          key: `read:${source.source}`,
          kind: 'read',
          group: 'data',
          label: source.label,
          description: source.description || kind.description,
          executable: source.executable,
          reason: source.reason,
          options: { source: source.source },
        });
      continue;
    }
    if (kind.kind === 'capability' && vocabulary.capabilities.length) {
      for (const action of vocabulary.capabilities)
        items.push({
          key: `capability:${action.capability}@${action.version}`,
          kind: 'capability',
          group: 'act',
          label: action.label,
          description: action.description || kind.description,
          executable: action.executable,
          reason: action.reason,
          options: { capability: `${action.capability}@${action.version}` },
        });
      continue;
    }
    items.push({
      key: kind.kind,
      kind: kind.kind,
      group: groups[kind.kind],
      label: kind.label,
      description: kind.description,
      executable:
        kind.kind === 'code'
          ? vocabulary.codeSteps.executable || vocabulary.codeSteps.evaluation
          : kind.executable,
      reason: kind.reason,
      options: {},
    });
  }

  return items;
}

/** Short facts shown on a collapsed step so the list can be scanned without opening it. */
export function stepFacts(
  content: WorkflowDraftContent,
  index: number,
): string[] {
  const step = content.steps[index];
  if (!step) return [];
  switch (step.kind) {
    case 'read':
      return Object.keys(step.fields).map(humanize);
    case 'condition':
      return [
        step.onFalse === 'end'
          ? m.authoring_fact_otherwise_finish()
          : m.authoring_fact_otherwise_escalate(),
      ];
    case 'capability':
      return [
        riskFacts[step.minimumRisk](),
        content.steps[index - 1]?.kind === 'approval'
          ? m.authoring_fact_asks_person()
          : m.authoring_fact_rules_decide(),
      ];
    case 'approval':
      return [
        m.authoring_fact_decide_within({
          duration: formatDuration(step.expiresAfterSeconds),
        }),
      ];
    case 'wait':
      return [formatDuration(step.seconds)];
    case 'verification':
      return [
        m.authoring_fact_check_within({
          duration: formatDuration(step.maxDurationSeconds),
        }),
      ];
    case 'code':
      return [
        ...Object.keys(step.fields).map((field) =>
          m.authoring_fact_returns({ field: humanize(field) }),
        ),
        ...(step.grants.length
          ? [m.authoring_fact_requests({ count: step.grants.length })]
          : []),
      ];
    default:
      return [];
  }
}
