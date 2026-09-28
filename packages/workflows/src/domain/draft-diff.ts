import type { DraftStep, WorkflowDraftContent } from './draft.js';
import { describeStep, humanize } from './draft-presentation.js';
import type { AuthoringVocabulary } from './vocabulary.js';

/**
 * One reviewable difference between two drafts. Step changes name the step; workflow-level
 * changes have a null `stepId` and name the changed setting in `field`.
 */
export interface DraftChange {
  change: 'added' | 'removed' | 'changed' | 'moved';
  stepId: string | null;
  /** The workflow setting that changed, such as `applicability.trigger`. Null for steps. */
  field: string | null;
  before: DraftStep | null;
  after: DraftStep | null;
  summary: string;
}

/** Serializes a value with sorted keys so equal content compares equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (name) =>
          `${JSON.stringify(name)}:${canonical((value as Record<string, unknown>)[name])}`,
      )
      .join(',')}}`;

  return JSON.stringify(value ?? null);
}

const same = (left: unknown, right: unknown) =>
  canonical(left) === canonical(right);

/** IDs kept in the same relative order, found with a longest common subsequence. */
function stableOrder(before: string[], after: string[]): Set<string> {
  const lengths = before.map(() => after.map(() => 0));
  const at = (i: number, j: number) => lengths[i]?.[j] ?? 0;
  for (let i = before.length - 1; i >= 0; i -= 1)
    for (let j = after.length - 1; j >= 0; j -= 1)
      lengths[i]![j] =
        before[i] === after[j]
          ? at(i + 1, j + 1) + 1
          : Math.max(at(i + 1, j), at(i, j + 1));
  const kept = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      kept.add(before[i]!);
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) i += 1;
    else j += 1;
  }

  return kept;
}

function fieldChanges(
  before: Record<string, string>,
  after: Record<string, string>,
) {
  const added = Object.keys(after).filter((name) => !(name in before));
  const removed = Object.keys(before).filter((name) => !(name in after));
  const retyped = Object.keys(after).filter(
    (name) => name in before && before[name] !== after[name],
  );

  return [
    added.length ? `adds ${added.join(', ')}` : '',
    removed.length ? `removes ${removed.join(', ')}` : '',
    retyped.length ? `changes the type of ${retyped.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('; ');
}

/** Lists workflow-level differences outside the step list. */
function settingChanges(
  before: WorkflowDraftContent,
  after: WorkflowDraftContent,
  vocabulary: AuthoringVocabulary,
): DraftChange[] {
  const changes: DraftChange[] = [];
  const setting = (field: string, summary: string) =>
    changes.push({
      change: 'changed',
      stepId: null,
      field,
      before: null,
      after: null,
      summary,
    });

  const definition = (['name', 'intent', 'category'] as const).filter(
    (name) => before.definition[name] !== after.definition[name],
  );
  if (definition.length)
    setting(
      'definition',
      definition.includes('name')
        ? `Renames the workflow to “${after.definition.name}”.`
        : `Changes the workflow ${definition.map((name) => (name === 'intent' ? 'description' : name)).join(' and ')}.`,
    );
  if (!same(before.applicability.trigger, after.applicability.trigger)) {
    const trigger = vocabulary.triggers.find(
      (item) => item.kind === after.applicability.trigger.kind,
    );
    setting(
      'applicability.trigger',
      `Changes how runs start: ${trigger?.label.toLowerCase() ?? humanize(after.applicability.trigger.kind)}.`,
    );
  }
  if (before.applicability.subjectKind !== after.applicability.subjectKind) {
    const subject = vocabulary.subjects.find(
      (item) => item.kind === after.applicability.subjectKind,
    );
    setting(
      'applicability.subjectKind',
      `Changes the subject to ${subject?.label.toLowerCase() ?? (humanize(after.applicability.subjectKind) || 'nothing')}.`,
    );
  }
  if (!same(before.inputs, after.inputs))
    setting('inputs', `Inputs: ${fieldChanges(before.inputs, after.inputs)}.`);
  if (!same(before.context, after.context))
    setting(
      'context',
      same(before.context.fields, after.context.fields)
        ? 'Changes the evidence settings.'
        : `Evidence fields: ${fieldChanges(before.context.fields, after.context.fields)}.`,
    );

  return changes;
}

/**
 * Compares two drafts step by step. Steps match by ID. A step whose position changed relative to
 * the other kept steps is `moved`; a step can be both moved and changed.
 */
export function diffDraft(
  before: WorkflowDraftContent,
  after: WorkflowDraftContent,
  vocabulary: AuthoringVocabulary,
): DraftChange[] {
  const previous = new Map(
    before.steps.map((step, index) => [step.id, { step, index }]),
  );
  const next = new Set(after.steps.map((step) => step.id));
  const kept = stableOrder(
    before.steps.map((step) => step.id).filter((id) => next.has(id)),
    after.steps.map((step) => step.id).filter((id) => previous.has(id)),
  );
  const described = (step: DraftStep) =>
    describeStep(step, vocabulary).description;
  const changes = settingChanges(before, after, vocabulary);

  after.steps.forEach((step, index) => {
    const earlier = previous.get(step.id);
    if (!earlier) {
      changes.push({
        change: 'added',
        stepId: step.id,
        field: null,
        before: null,
        after: step,
        summary: `Adds “${step.id}”: ${described(step)}`,
      });

      return;
    }
    if (!kept.has(step.id))
      changes.push({
        change: 'moved',
        stepId: step.id,
        field: null,
        before: earlier.step,
        after: step,
        summary: `Moves “${step.id}” from step ${earlier.index + 1} to step ${index + 1}.`,
      });
    if (!same(earlier.step, step)) {
      const changed = [
        ...new Set([...Object.keys(earlier.step), ...Object.keys(step)]),
      ].filter(
        (name) =>
          !same(
            (earlier.step as unknown as Record<string, unknown>)[name],
            (step as unknown as Record<string, unknown>)[name],
          ),
      );
      changes.push({
        change: 'changed',
        stepId: step.id,
        field: null,
        before: earlier.step,
        after: step,
        summary: `Changes ${changed.map(humanize).join(', ')} of “${step.id}”: ${described(step)}`,
      });
    }
  });
  for (const step of before.steps)
    if (!next.has(step.id))
      changes.push({
        change: 'removed',
        stepId: step.id,
        field: null,
        before: step,
        after: null,
        summary: `Removes “${step.id}”: ${described(step)}`,
      });

  return changes;
}
