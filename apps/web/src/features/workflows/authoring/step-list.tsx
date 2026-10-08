import { useDroppable } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type {
  AuthoringVocabulary,
  DraftValidation,
  WorkflowDiagnostic,
  WorkflowDraftContent,
} from '@luma/api-contract';
import { formatDateTime } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@luma/ui/components/primitives/dropdown-menu';
import { Input } from '@luma/ui/components/primitives/input';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Copy,
  Ellipsis,
  GripVertical,
  Play,
  Plus,
  Trash2,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { humanize, stepFacts } from './draft-model';
import { Field, FieldProblems, StepForm } from './step-forms';
import { StepKindIcon, stepKinds } from './step-kinds';

/** Shows a scheduled start in the reader's language, or the raw text while it isn't a valid time. */
function scheduledAt(value: string) {
  return Number.isNaN(Date.parse(value))
    ? value
    : formatDateTime(value, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC',
        timeZoneName: 'short',
      });
}

/** Shows how and for what the workflow starts, at the top of the step list. */
export function StartNode({
  content,
  vocabulary,
}: {
  content: WorkflowDraftContent;
  vocabulary: AuthoringVocabulary;
}) {
  const trigger = content.applicability.trigger;
  const label =
    vocabulary.triggers.find((item) => item.kind === trigger.kind)?.label ??
    humanize(trigger.kind);
  const detail =
    trigger.kind === 'condition'
      ? trigger.field
        ? m.authoring_start_condition({
            field: humanize(trigger.field),
            value: JSON.stringify(trigger.equals),
          })
        : m.authoring_start_condition_unset()
      : trigger.kind === 'event'
        ? humanize(trigger.eventType) || m.authoring_start_event_unset()
        : trigger.kind === 'exception'
          ? humanize(trigger.issueType) || m.authoring_start_issue_unset()
          : trigger.kind === 'schedule'
            ? scheduledAt(trigger.at)
            : null;
  const subject =
    vocabulary.subjects.find(
      (item) => item.kind === content.applicability.subjectKind,
    )?.label ?? humanize(content.applicability.subjectKind);

  return (
    <div className="authoring-start" aria-label={m.authoring_start_label()}>
      <span className="authoring-kind-icon" data-kind="start">
        <Play aria-hidden="true" size={16} />
      </span>
      <div>
        <span className="authoring-step-kind" data-kind="start">
          {m.authoring_start_kind()}
        </span>
        <strong>
          {detail
            ? m.authoring_start_trigger({ trigger: label, detail })
            : label}
        </strong>
        <span className="authoring-hint">
          {subject
            ? m.authoring_start_subject({ subject })
            : m.authoring_start_subject_unset()}
        </span>
      </div>
    </div>
  );
}

/** A place between steps. Accepts dropped steps and lets authors choose it as the insert point. */
export function InsertSlot({
  index,
  count,
  active,
  receiving,
  selected,
  onSelect,
}: {
  index: number;
  count: number;
  /** A palette step is being dragged, so every slot can receive it. */
  receiving: boolean;
  /** The dragged step would land here. */
  active: boolean;
  selected: boolean;
  onSelect(index: number): void;
}) {
  // Slots only accept new steps; keeping them out of reordering lets arrow keys move between steps.
  const { setNodeRef } = useDroppable({
    id: `slot:${index}`,
    disabled: !receiving,
  });
  const label =
    index === 0
      ? m.authoring_slot_add_start()
      : m.authoring_slot_add_after({ step: index });

  return (
    <div
      ref={setNodeRef}
      className="authoring-slot"
      data-receiving={receiving}
      data-active={active}
      data-selected={selected}
      data-empty={count === 0}
    >
      {receiving ? (
        <span className="authoring-slot-drop" aria-hidden="true">
          {active ? m.authoring_slot_release() : m.authoring_slot_drop()}
        </span>
      ) : count === 0 ? (
        <button
          type="button"
          className="authoring-slot-empty"
          aria-label={label}
          onClick={() => onSelect(index)}
        >
          <Plus aria-hidden="true" size={18} />
          <strong>{m.authoring_slot_first_title()}</strong>
          <span>{m.authoring_slot_first_hint()}</span>
        </button>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="authoring-slot-button"
          aria-label={label}
          aria-pressed={selected}
          onClick={() => onSelect(index)}
        >
          <Plus aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}

/**
 * One step in the list: colour-coded by type, reorderable by dragging its handle (or with the
 * keyboard), and expandable to edit it.
 */
export function StepCard({
  sortableId,
  index,
  content,
  validation,
  vocabulary,
  readOnly,
  expanded,
  focused,
  questions,
  problems,
  onToggle,
  onChange,
  onMove,
  onDuplicate,
  onRemove,
  onRename,
  openCode,
  after,
}: {
  sortableId: string;
  index: number;
  content: WorkflowDraftContent;
  validation: DraftValidation | undefined;
  vocabulary: AuthoringVocabulary;
  readOnly: boolean;
  expanded: boolean;
  focused: boolean;
  questions: { question: string }[];
  problems: WorkflowDiagnostic[];
  onToggle(): void;
  onChange(next: WorkflowDraftContent): void;
  onMove(to: number): void;
  onDuplicate(): void;
  onRemove(): void;
  onRename(to: string): void;
  openCode(): void;
  /** Rendered below the card, such as the insert point after this step. */
  after?: ReactNode;
}) {
  const step = content.steps[index]!;
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sortableId, disabled: readOnly });
  const described = validation?.steps[index];
  const errors = problems.filter((item) => item.severity === 'error');
  const limited = problems.some((item) => item.code === 'step_not_executable');
  const facts = stepFacts(content, index);
  const last = index === content.steps.length - 1;

  return (
    <li
      ref={setNodeRef}
      id={`authoring-step-${index}`}
      className="authoring-step"
      data-kind={step.kind}
      data-invalid={errors.length > 0}
      data-focused={focused}
      data-expanded={expanded}
      data-dragging={isDragging}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <span className="authoring-step-number" aria-hidden="true">
        {index + 1}
      </span>
      <div className="authoring-step-card">
        <div className="authoring-step-header">
          {!readOnly ? (
            <button
              ref={setActivatorNodeRef}
              type="button"
              className="authoring-step-handle"
              {...attributes}
              {...listeners}
              aria-label={m.authoring_step_reorder({ step: index + 1 })}
            >
              <GripVertical aria-hidden="true" size={16} />
            </button>
          ) : null}
          <StepKindIcon kind={step.kind} />
          <button
            type="button"
            className="authoring-step-toggle"
            aria-expanded={expanded}
            aria-controls={`authoring-step-body-${index}`}
            onClick={onToggle}
          >
            <span className="authoring-step-kind" data-kind={step.kind}>
              <span className="sr-only">
                {m.authoring_step_position({ step: index + 1 })}{' '}
              </span>
              {described?.title ?? stepKinds[step.kind].name()}
            </span>
            <strong className="authoring-step-description">
              {described?.description ?? step.id}
            </strong>
            {facts.length ? (
              <span className="authoring-step-facts">
                {facts.map((fact) => (
                  <span key={fact}>{fact}</span>
                ))}
              </span>
            ) : null}
          </button>
          <div className="authoring-step-badges">
            {errors.length ? (
              <Badge tone="danger">
                {m.authoring_step_problems({ count: errors.length })}
              </Badge>
            ) : null}
            {questions.length ? (
              <Badge tone="info">{m.authoring_step_question()}</Badge>
            ) : null}
            {limited ? (
              <Badge tone="warning">{m.authoring_limited_badge()}</Badge>
            ) : null}
          </div>
          <ChevronDown
            className="authoring-step-chevron"
            aria-hidden="true"
            size={16}
          />
          {!readOnly ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={m.authoring_step_actions({ step: index + 1 })}
                  />
                }
              >
                <Ellipsis aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={index === 0}
                  onClick={() => onMove(index - 1)}
                >
                  <ArrowUp aria-hidden="true" /> {m.authoring_step_move_up()}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={last}
                  onClick={() => onMove(index + 1)}
                >
                  <ArrowDown aria-hidden="true" />{' '}
                  {m.authoring_step_move_down()}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onDuplicate}>
                  <Copy aria-hidden="true" /> {m.authoring_step_duplicate()}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={onRemove}>
                  <Trash2 aria-hidden="true" /> {m.common_delete()}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        {expanded ? (
          <div
            id={`authoring-step-body-${index}`}
            className="authoring-step-body"
          >
            {questions.map((item) => (
              <p key={item.question} className="authoring-question" role="note">
                {item.question}
              </p>
            ))}
            <FieldProblems
              id={`authoring-step-problems-${index}`}
              diagnostics={problems.filter(
                (item) => item.field === null || item.field === 'kind',
              )}
            />
            <StepForm
              index={index}
              content={content}
              scope={described?.scope ?? []}
              vocabulary={vocabulary}
              diagnostics={problems}
              disabled={readOnly}
              onContent={onChange}
              openCode={openCode}
            />
            <Disclosure variant="plain" className="authoring-advanced">
              <summary>{m.authoring_step_id_label()}</summary>
              <Field
                label={m.authoring_step_id_label()}
                hint={m.authoring_step_id_hint()}
                diagnostics={problems.filter((item) => item.field === 'id')}
              >
                {(props) => (
                  <Input
                    {...props}
                    disabled={readOnly}
                    defaultValue={step.id}
                    onBlur={(event) => {
                      const next = event.target.value.trim();
                      if (next && next !== step.id) onRename(next);
                    }}
                  />
                )}
              </Field>
            </Disclosure>
          </div>
        ) : null}
      </div>
      {after}
    </li>
  );
}

/** A compact preview of the step being dragged. */
export function DragPreview({
  kind,
  label,
}: {
  kind: Parameters<typeof StepKindIcon>[0]['kind'];
  label: string;
}) {
  return (
    <div className="authoring-drag-preview" data-kind={kind}>
      <StepKindIcon kind={kind} />
      <strong>{label}</strong>
    </div>
  );
}
