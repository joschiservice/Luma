import { codeOwnedSteps } from './code-grants.js';
import type { DraftStep, WorkflowDraftContent } from './draft.js';
import { diagnostic, type WorkflowDiagnostic } from './draft.js';
import type { PlaybookFields, PlaybookScalar } from './playbook.js';
import type { ProcessStep, ProcessValue } from './process.js';
import type { WorkflowTrigger } from './workflow.js';

type FieldType = PlaybookFields[string];

/** Whether an installed adapter runs an entry in custom workflows in this workspace. */
export interface VocabularyAvailability {
  executable: boolean;
  /** Why the entry cannot run here. Null when it can. */
  reason: string | null;
}

interface TriggerEntry extends VocabularyAvailability {
  kind: WorkflowTrigger['kind'];
  label: string;
  description: string;
}

interface StepKindEntry extends VocabularyAvailability {
  kind: ProcessStep['kind'];
  label: string;
  description: string;
}

interface SubjectEntry extends VocabularyAvailability {
  kind: string;
  label: string;
  description: string;
}

interface ReadEntry extends VocabularyAvailability {
  source: string;
  label: string;
  description: string;
  fields: PlaybookFields;
}

interface CapabilityEntry extends VocabularyAvailability {
  capability: string;
  version: string;
  label: string;
  description: string;
  targetKind: string;
  /** Lowest risk the action may declare. Policy can still require approval. */
  minimumRisk: 'low' | 'medium' | 'high';
  /** Plain-language approval behaviour applied by Action Admission. */
  approval: string;
  parameters: PlaybookFields;
  postcondition: PlaybookFields;
  /** Evaluator versions that can verify this capability. */
  evaluators: string[];
}

interface EvaluatorEntry extends VocabularyAvailability {
  version: string;
  label: string;
  description: string;
  fields: PlaybookFields;
}

export interface CodeStepSupport extends VocabularyAvailability {
  /** Whether Code Steps can be evaluated with example data in this deployment. */
  evaluation: boolean;
  runtime: string;
  limits: {
    fuel: number;
    memoryBytes: number;
    wallTimeMs: number;
    maxRequests: number;
  };
}

/** What authors can use in this workspace, with the reason for anything that cannot run. */
export interface AuthoringVocabulary {
  triggers: TriggerEntry[];
  stepKinds: StepKindEntry[];
  subjects: SubjectEntry[];
  reads: ReadEntry[];
  capabilities: CapabilityEntry[];
  evaluators: EvaluatorEntry[];
  codeSteps: CodeStepSupport;
}

/** One installed adapter's authoring entries. Executable flags describe this adapter only. */
export interface VocabularyContribution {
  triggers?: {
    kind: TriggerEntry['kind'];
    executable: boolean;
    reason?: string;
  }[];
  stepKinds?: {
    kind: StepKindEntry['kind'];
    executable: boolean;
    reason?: string;
  }[];
  subjects?: SubjectEntry[];
  reads?: ReadEntry[];
  capabilities?: CapabilityEntry[];
  evaluators?: EvaluatorEntry[];
  codeSteps?: Partial<Pick<CodeStepSupport, 'evaluation'>> &
    VocabularyAvailability;
}

const unsupported =
  'No installed app can run this in custom workflows in this workspace.';

const triggerLabels: Record<TriggerEntry['kind'], [string, string]> = {
  manual: [
    'Started by a person',
    'Someone who can manage workflow triggers starts a run.',
  ],
  event: ['When an event arrives', 'A system reports an event.'],
  schedule: ['At a scheduled time', 'The run starts once at a fixed time.'],
  condition: [
    'When a condition is true',
    'A monitored fact matches a value, such as stock below its minimum.',
  ],
  exception: ['When an issue is detected', 'Luma opens an operational issue.'],
};

const stepLabels: Record<StepKindEntry['kind'], [string, string]> = {
  read: ['Read current data', 'Get fresh data from a connected system.'],
  condition: [
    'Check a condition',
    'Continue only when a field has a specific value.',
  ],
  capability: [
    'Take an action',
    'Ask a connected system to make a change. Luma checks your approval rules first.',
  ],
  approval: [
    'Ask for approval',
    'Wait for someone who can approve changes to decide on the next action.',
  ],
  wait: ['Wait', 'Pause for a fixed time before continuing.'],
  human_task: [
    'Ask a person',
    'Assign work, collect evidence and continue when answered.',
  ],
  event_wait: [
    'Wait for an event',
    'Wait for a correlated business event within a deadline.',
  ],
  verification: [
    'Check the result',
    'Read the data again, independently, to confirm the change worked.',
  ],
  escalation: ['Escalate', 'Stop and hand the run to a person.'],
  end: ['Finish', 'Finish the run with a named outcome.'],
  code: [
    'Run a code step',
    'Compute values with TypeScript, run in isolation, when the builder isn’t enough.',
  ],
};

/** Combines adapter contributions with the `workflow/2` language. Missing support stays visible. */
export function mergeVocabulary(
  contributions: VocabularyContribution[],
  codeStep: Omit<CodeStepSupport, keyof VocabularyAvailability | 'evaluation'>,
): AuthoringVocabulary {
  const availability = <K extends string>(
    kind: K,
    entries: { kind: K; executable: boolean; reason?: string }[],
  ): VocabularyAvailability => {
    const matching = entries.filter((entry) => entry.kind === kind);
    if (matching.some((entry) => entry.executable))
      return { executable: true, reason: null };

    return {
      executable: false,
      reason: matching.find((entry) => entry.reason)?.reason ?? unsupported,
    };
  };
  const unique = <T extends VocabularyAvailability>(
    items: T[],
    key: (item: T) => string,
  ) => {
    const merged = new Map<string, T>();
    for (const item of items) {
      const existing = merged.get(key(item));
      merged.set(
        key(item),
        !existing || (!existing.executable && item.executable)
          ? item
          : existing,
      );
    }

    return [...merged.values()].sort((a, b) => key(a).localeCompare(key(b)));
  };
  const triggers = contributions.flatMap((item) => item.triggers ?? []);
  const stepKinds = contributions.flatMap((item) => item.stepKinds ?? []);
  const code = contributions.flatMap((item) =>
    item.codeSteps ? [item.codeSteps] : [],
  );

  return {
    triggers: (Object.keys(triggerLabels) as TriggerEntry['kind'][]).map(
      (kind) => ({
        kind,
        label: triggerLabels[kind][0],
        description: triggerLabels[kind][1],
        ...availability(kind, triggers),
      }),
    ),
    stepKinds: (Object.keys(stepLabels) as StepKindEntry['kind'][]).map(
      (kind) => ({
        kind,
        label: stepLabels[kind][0],
        description: stepLabels[kind][1],
        ...availability(kind, stepKinds),
      }),
    ),
    subjects: unique(
      contributions.flatMap((item) => item.subjects ?? []),
      (item) => item.kind,
    ),
    reads: unique(
      contributions.flatMap((item) => item.reads ?? []),
      (item) => item.source,
    ),
    capabilities: unique(
      contributions.flatMap((item) => item.capabilities ?? []),
      (item) => `${item.capability}@${item.version}`,
    ),
    evaluators: unique(
      contributions.flatMap((item) => item.evaluators ?? []),
      (item) => item.version,
    ),
    codeSteps: {
      ...codeStep,
      evaluation: code.some((item) => item.evaluation),
      ...(code.some((item) => item.executable)
        ? { executable: true, reason: null }
        : {
            executable: false,
            reason: code.find((item) => item.reason)?.reason ?? unsupported,
          }),
    },
  };
}

/** A value an author may reference at a given point in the workflow. */
export interface ValueOption {
  source: 'input' | 'evidence' | 'step';
  stepId: string | null;
  field: string;
  type: FieldType;
}

/** Lists the inputs, evidence fields and earlier outputs available before each step. */
export function stepScopes(content: WorkflowDraftContent): ValueOption[][] {
  const base: ValueOption[] = [
    ...Object.entries(content.inputs).map(([field, type]) => ({
      source: 'input' as const,
      stepId: null,
      field,
      type,
    })),
    ...Object.entries(content.context.fields).map(([field, type]) => ({
      source: 'evidence' as const,
      stepId: null,
      field,
      type,
    })),
  ];
  const owned = codeOwnedSteps(content as { steps: ProcessStep[] });
  const scopes: ValueOption[][] = [];
  const earlier: ValueOption[] = [];
  for (const step of content.steps) {
    scopes.push([...base, ...earlier]);
    if (step.kind === 'human_task')
      earlier.push(
        ...['choice', 'note', 'actorId', 'evidence'].map((field) => ({
          source: 'step' as const,
          stepId: step.id,
          field,
          type: 'string' as const,
        })),
      );
    if (
      (step.kind === 'read' && !owned.has(step.id)) ||
      step.kind === 'code' ||
      step.kind === 'event_wait'
    )
      earlier.push(
        ...Object.entries(step.fields).map(([field, type]) => ({
          source: 'step' as const,
          stepId: step.id,
          field,
          type,
        })),
      );
  }

  return scopes;
}

const typeOf = (value: PlaybookScalar): FieldType =>
  value === null ? 'null' : (typeof value as FieldType);

function valueType(value: ProcessValue, scope: ValueOption[]) {
  if (value.source === 'literal') return typeOf(value.value);

  return scope.find(
    (option) =>
      option.source === value.source &&
      option.field === value.field &&
      (value.source !== 'step' || option.stepId === value.stepId),
  )?.type;
}

const riskOrder = { low: 0, medium: 1, high: 2 } as const;

/** Checks a draft against the workspace vocabulary. Unknown entries are errors; limits are warnings. */
export function checkVocabulary(
  content: WorkflowDraftContent,
  vocabulary: AuthoringVocabulary,
): WorkflowDiagnostic[] {
  const found: WorkflowDiagnostic[] = [];
  const scopes = stepScopes(content);
  const trigger = vocabulary.triggers.find(
    (item) => item.kind === content.applicability.trigger.kind,
  );
  if (trigger && !trigger.executable)
    found.push(
      diagnostic(
        'trigger_not_executable',
        `Runs can't start this way in this workspace yet. ${trigger.reason}`,
        `Trigger ${trigger.kind} has no executing adapter`,
        { field: 'applicability.trigger.kind', severity: 'warning' },
      ),
    );
  const subject = vocabulary.subjects.find(
    (item) => item.kind === content.applicability.subjectKind,
  );
  if (!subject)
    found.push(
      diagnostic(
        'unknown_subject',
        `Choose a subject this workspace knows: ${vocabulary.subjects.map((item) => item.label).join(', ') || 'none installed'}.`,
        `Unknown subject kind ${content.applicability.subjectKind}`,
        { field: 'applicability.subjectKind' },
      ),
    );

  content.steps.forEach((step: DraftStep, stepIndex) => {
    const at = (field: string | null, severity?: 'warning') => ({
      stepIndex,
      stepId: step.id,
      field,
      ...(severity ? { severity } : {}),
    });
    const kind = vocabulary.stepKinds.find((item) => item.kind === step.kind);
    const limited = (entry: VocabularyAvailability | undefined) => {
      if (entry && !entry.executable)
        found.push(
          diagnostic(
            'step_not_executable',
            `This step can't run in this workspace yet. ${entry.reason}`,
            `No executing adapter for ${step.kind} step ${step.id}`,
            at(null, 'warning'),
          ),
        );
    };
    const fieldsWithin = (
      declared: PlaybookFields,
      provided: PlaybookFields,
      owner: string,
    ) => {
      for (const [name, type] of Object.entries(declared)) {
        if (!Object.hasOwn(provided, name))
          found.push(
            diagnostic(
              'unknown_field',
              `${owner} doesn't provide “${name}”. Available: ${Object.keys(provided).join(', ') || 'none'}.`,
              `Field ${name} is not provided by ${owner}`,
              at(`fields.${name}`),
            ),
          );
        else if (provided[name] !== type)
          found.push(
            diagnostic(
              'field_type_mismatch',
              `“${name}” is a ${provided[name]}, not a ${type}.`,
              `Field ${name} has type ${provided[name]}`,
              at(`fields.${name}`),
            ),
          );
      }
    };

    if (step.kind === 'read') {
      const source = vocabulary.reads.find(
        (item) => item.source === step.source,
      );
      if (!source) {
        found.push(
          diagnostic(
            'unknown_read',
            'Choose a data source installed in this workspace.',
            `Unknown read source ${step.source}`,
            at('source'),
          ),
        );

        return;
      }
      fieldsWithin(step.fields, source.fields, source.label);
      limited(source);
    } else if (step.kind === 'capability') {
      const entry = vocabulary.capabilities.find(
        (item) =>
          item.capability === step.capability &&
          item.version === step.capabilityVersion,
      );
      if (!entry) {
        found.push(
          diagnostic(
            'unknown_capability',
            'Choose an action installed in this workspace.',
            `Unknown capability ${step.capability}@${step.capabilityVersion}`,
            at('capability'),
          ),
        );

        return;
      }
      if (step.targetKind !== entry.targetKind)
        found.push(
          diagnostic(
            'target_mismatch',
            `This action changes a ${entry.targetKind.replaceAll('_', ' ')}.`,
            `Capability targets ${entry.targetKind}, not ${step.targetKind}`,
            at('targetKind'),
          ),
        );
      if (riskOrder[step.minimumRisk] < riskOrder[entry.minimumRisk])
        found.push(
          diagnostic(
            'risk_below_floor',
            `This action is at least ${entry.minimumRisk} risk. Choose ${entry.minimumRisk} or higher.`,
            `Risk ${step.minimumRisk} is below the capability floor ${entry.minimumRisk}`,
            at('minimumRisk'),
          ),
        );
      for (const [group, declared, supplied] of [
        ['parameters', entry.parameters, step.parameters],
        [
          'expectedPostcondition',
          entry.postcondition,
          step.expectedPostcondition,
        ],
      ] as const) {
        for (const name of Object.keys(declared))
          if (!Object.hasOwn(supplied, name))
            found.push(
              diagnostic(
                'missing_value',
                `Set “${name}” for this action.`,
                `Missing ${group}.${name}`,
                at(`${group}.${name}`),
              ),
            );
        for (const [name, value] of Object.entries(supplied)) {
          if (!Object.hasOwn(declared, name)) {
            found.push(
              diagnostic(
                'unknown_value',
                `This action doesn't accept “${name}”.`,
                `Unknown ${group}.${name}`,
                at(`${group}.${name}`),
              ),
            );
            continue;
          }
          const type = valueType(value, scopes[stepIndex] ?? []);
          if (type && type !== declared[name])
            found.push(
              diagnostic(
                'value_type_mismatch',
                `“${name}” needs a ${declared[name]}, but this value is a ${type}.`,
                `${group}.${name} expects ${declared[name]}, got ${type}`,
                at(`${group}.${name}`),
              ),
            );
        }
      }
      limited(entry);
    } else if (step.kind === 'verification') {
      const action = content.steps.find((item) => item.id === step.forStep);
      const capability =
        action?.kind === 'capability'
          ? vocabulary.capabilities.find(
              (item) =>
                item.capability === action.capability &&
                item.version === action.capabilityVersion,
            )
          : undefined;
      const evaluator = vocabulary.evaluators.find(
        (item) => item.version === step.evaluatorVersion,
      );
      if (
        !evaluator ||
        (capability && !capability.evaluators.includes(evaluator.version))
      ) {
        found.push(
          diagnostic(
            'unknown_evaluator',
            capability
              ? `Choose a check that verifies this action: ${capability.evaluators.join(', ') || 'none installed'}.`
              : 'Choose a result check installed in this workspace.',
            `Evaluator ${step.evaluatorVersion} cannot verify ${step.forStep}`,
            at('evaluatorVersion'),
          ),
        );

        return;
      }
      fieldsWithin(step.fields, evaluator.fields, evaluator.label);
      limited(evaluator);
    } else if (step.kind === 'code') {
      if (!vocabulary.codeSteps.executable || step.grants.length)
        found.push(
          diagnostic(
            'step_not_executable',
            `This step can't run in this workspace yet. ${
              step.grants.length && vocabulary.codeSteps.executable
                ? 'Code Steps that request reads or actions need an installed business adapter.'
                : vocabulary.codeSteps.reason
            }`,
            `No executing adapter for code step ${step.id}`,
            at(null, 'warning'),
          ),
        );
    } else limited(kind);
  });

  return found;
}

/** Explains why no installed adapter can run a version, or returns an empty list. */
export function executionBlockers(
  content: WorkflowDraftContent,
  vocabulary: AuthoringVocabulary,
): string[] {
  return [
    ...new Set(
      checkVocabulary(content, vocabulary).map((item) => item.message),
    ),
  ];
}
