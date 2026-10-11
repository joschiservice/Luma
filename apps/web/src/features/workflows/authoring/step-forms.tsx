import type {
  AuthoringVocabulary,
  DraftStep,
  ValueOption,
  WorkflowDiagnostic,
  WorkflowDraftContent,
} from '@luma/api-contract';
import { formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { PersonPicker } from '@luma/ui/components/primitives/person-picker';
import { Select } from '@luma/ui/components/primitives/select';
import { Textarea } from '@luma/ui/components/primitives/textarea';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { Plus, Trash2 } from 'lucide-react';
import { type ReactNode, useId } from 'react';

import { membersOptions } from '../../../kit/settings/data';
import {
  emptyValue,
  type FieldType,
  humanize,
  type StepValue,
  updateStep,
  valueKey,
  valueLabel,
} from './draft-model';

const typeLabels = {
  string: m.authoring_field_type_text,
  number: m.authoring_field_type_number,
  boolean: m.authoring_field_type_boolean,
  null: m.authoring_field_type_empty,
} satisfies Record<FieldType, () => string>;

const typeNeeds = {
  string: m.authoring_value_needs_text,
  number: m.authoring_value_needs_number,
  boolean: m.authoring_value_needs_boolean,
  null: m.authoring_value_needs_empty,
} satisfies Record<FieldType, () => string>;

const fieldTypes = () =>
  (Object.keys(typeLabels) as FieldType[]).map((value) => ({
    value,
    label: typeLabels[value](),
  }));

const riskLabels = {
  low: m.authoring_risk_low,
  medium: m.authoring_risk_medium,
  high: m.authoring_risk_high,
} satisfies Record<'low' | 'medium' | 'high', () => string>;

const minimumRisks = {
  low: m.authoring_action_minimum_risk_low,
  medium: m.authoring_action_minimum_risk_medium,
  high: m.authoring_action_minimum_risk_high,
} satisfies Record<'low' | 'medium' | 'high', () => string>;

/** Adds a note to an option the workspace can't run yet. */
function limitedOption(label: string, executable: boolean) {
  return executable ? label : m.authoring_option_limited({ option: label });
}

/** Shows the diagnostics for one field next to its control. */
export function FieldProblems({
  id,
  diagnostics,
}: {
  id: string;
  diagnostics: WorkflowDiagnostic[];
}) {
  if (!diagnostics.length) return null;

  return (
    <ul id={id} className="authoring-field-problems">
      {diagnostics.map((item) => (
        <li
          key={`${item.code}:${item.field}:${item.message}`}
          data-severity={item.severity}
        >
          {item.message}
        </li>
      ))}
    </ul>
  );
}

/** A labelled control with its diagnostics announced as its description. */
export function Field({
  label,
  hint,
  diagnostics = [],
  children,
}: {
  label: string;
  hint?: string | undefined;
  diagnostics?: WorkflowDiagnostic[] | undefined;
  children(props: {
    id: string;
    'aria-describedby'?: string | undefined;
    'aria-invalid'?: boolean | undefined;
  }): ReactNode;
}) {
  const id = useId();
  const described = [
    hint ? `${id}-hint` : '',
    diagnostics.length ? `${id}-problems` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className="authoring-field"
      data-invalid={diagnostics.some((item) => item.severity === 'error')}
    >
      <label htmlFor={id}>{label}</label>
      {children({
        id,
        ...(described ? { 'aria-describedby': described } : {}),
        ...(diagnostics.some((item) => item.severity === 'error')
          ? { 'aria-invalid': true }
          : {}),
      })}
      {hint ? (
        <p id={`${id}-hint`} className="authoring-hint">
          {hint}
        </p>
      ) : null}
      <FieldProblems id={`${id}-problems`} diagnostics={diagnostics} />
    </div>
  );
}

/** Edits a scalar with a control that matches its type. */
export function ScalarInput({
  type,
  value,
  onChange,
  disabled,
  ...props
}: {
  type: FieldType;
  value: string | number | boolean | null;
  onChange(value: string | number | boolean | null): void;
  disabled?: boolean | undefined;
  id?: string | undefined;
  'aria-label'?: string | undefined;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: boolean | undefined;
}) {
  if (type === 'boolean')
    return (
      <Select
        aria-label={props['aria-label'] ?? m.authoring_value_label()}
        {...(props['aria-describedby']
          ? { 'aria-describedby': props['aria-describedby'] }
          : {})}
        disabled={disabled}
        value={value === true ? 'yes' : 'no'}
        onValueChange={(next) => onChange(next === 'yes')}
        options={[
          { value: 'yes', label: m.common_yes() },
          { value: 'no', label: m.common_no() },
        ]}
      />
    );
  if (type === 'null')
    return <p className="authoring-hint">{m.authoring_field_type_empty()}</p>;

  return (
    <Input
      {...props}
      type={type === 'number' ? 'number' : 'text'}
      disabled={disabled}
      value={value === null ? '' : String(value)}
      onChange={(event) =>
        onChange(
          type === 'number'
            ? event.target.value === ''
              ? 0
              : Number(event.target.value)
            : event.target.value,
        )
      }
    />
  );
}

/**
 * Chooses where a value comes from: a fixed value, an input, an evidence field or an output of an
 * earlier step. Only values available at this point and of the needed type are offered.
 */
function ValuePicker({
  type,
  value,
  scope,
  onChange,
  label,
  disabled,
  diagnostics = [],
}: {
  type: FieldType | undefined;
  value: StepValue | undefined;
  scope: ValueOption[];
  onChange(value: StepValue): void;
  label: string;
  disabled?: boolean | undefined;
  diagnostics?: WorkflowDiagnostic[] | undefined;
}) {
  const options = scope.filter((option) => !type || option.type === type);
  const current = value ? valueKey(value) : 'literal';
  const known =
    current === 'literal' ||
    options.some((option) => valueKey(option) === current);

  return (
    <Field
      label={label}
      hint={type ? typeNeeds[type]() : undefined}
      diagnostics={diagnostics}
    >
      {(props) => (
        <div className="authoring-value-picker">
          <Select
            aria-label={m.authoring_value_source_label({ field: label })}
            {...(props['aria-describedby']
              ? { 'aria-describedby': props['aria-describedby'] }
              : {})}
            disabled={disabled}
            value={current}
            onValueChange={(next) => {
              if (!next || next === current) return;
              if (next === 'literal') {
                onChange({
                  source: 'literal',
                  value: emptyValue(type ?? 'string'),
                });

                return;
              }
              const option = options.find((item) => valueKey(item) === next);
              if (!option) return;
              onChange(
                option.source === 'step'
                  ? {
                      source: 'step',
                      stepId: option.stepId!,
                      field: option.field,
                    }
                  : { source: option.source, field: option.field },
              );
            }}
            options={[
              { value: 'literal', label: m.authoring_value_fixed() },
              ...options.map((option) => ({
                value: valueKey(option),
                label: valueLabel(option),
              })),
              ...(!known && value
                ? [
                    {
                      value: current,
                      label: m.authoring_value_unavailable({
                        value: valueLabel(value),
                      }),
                      disabled: true,
                    },
                  ]
                : []),
            ]}
          />
          {value?.source === 'literal' || !value ? (
            <ScalarInput
              {...props}
              aria-label={m.authoring_value_value_label({ field: label })}
              disabled={disabled}
              type={type ?? 'string'}
              value={
                value?.source === 'literal'
                  ? value.value
                  : emptyValue(type ?? 'string')
              }
              onChange={(next) => onChange({ source: 'literal', value: next })}
            />
          ) : null}
        </div>
      )}
    </Field>
  );
}

/** Edits named, typed fields such as inputs, evidence or Code Step outputs. */
export function FieldListEditor({
  label,
  fields,
  onChange,
  disabled,
  diagnostics = [],
}: {
  label: string;
  fields: Record<string, FieldType>;
  onChange(fields: Record<string, FieldType>): void;
  disabled?: boolean | undefined;
  diagnostics?: WorkflowDiagnostic[] | undefined;
}) {
  const entries = Object.entries(fields);
  const id = useId();
  const rename = (from: string, to: string) =>
    onChange(
      Object.fromEntries(
        entries.map(([name, type]) => [name === from ? to : name, type]),
      ),
    );

  return (
    <fieldset
      className="authoring-field-list"
      aria-describedby={diagnostics.length ? `${id}-problems` : undefined}
    >
      <legend>{label}</legend>
      {entries.length ? null : (
        <p className="authoring-hint">{m.authoring_field_list_empty()}</p>
      )}
      {entries.map(([name, type], index) => (
        <div key={index} className="authoring-field-row">
          <Input
            aria-label={m.authoring_field_list_name({
              list: label,
              position: index + 1,
            })}
            disabled={disabled}
            value={name}
            onChange={(event) => rename(name, event.target.value)}
          />
          <Select
            aria-label={m.authoring_field_list_type({
              list: label,
              position: index + 1,
            })}
            disabled={disabled}
            value={type}
            onValueChange={(next) =>
              next && onChange({ ...fields, [name]: next as FieldType })
            }
            options={fieldTypes()}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label={
              name
                ? m.authoring_field_list_remove({ field: name })
                : m.authoring_field_list_remove_unnamed({
                    list: label,
                    position: index + 1,
                  })
            }
            disabled={disabled}
            onClick={() =>
              onChange(
                Object.fromEntries(entries.filter(([key]) => key !== name)),
              )
            }
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={() => {
          let index = entries.length + 1;
          while (Object.hasOwn(fields, `field${index}`)) index++;
          onChange({ ...fields, [`field${index}`]: 'string' });
        }}
      >
        <Plus aria-hidden="true" /> {m.authoring_field_list_add()}
      </Button>
      <FieldProblems id={`${id}-problems`} diagnostics={diagnostics} />
    </fieldset>
  );
}

function FieldChoices({
  legend,
  available,
  chosen,
  onChange,
  disabled,
  diagnostics,
}: {
  legend: string;
  available: Record<string, FieldType>;
  chosen: Record<string, FieldType>;
  onChange(fields: Record<string, FieldType>): void;
  disabled?: boolean | undefined;
  diagnostics: WorkflowDiagnostic[];
}) {
  const id = useId();
  const names = [
    ...new Set([...Object.keys(available), ...Object.keys(chosen)]),
  ];

  return (
    <fieldset
      className="authoring-choices"
      aria-describedby={diagnostics.length ? `${id}-problems` : undefined}
    >
      <legend>{legend}</legend>
      {names.length ? null : (
        <p className="authoring-hint">{m.authoring_field_choices_empty()}</p>
      )}
      {names.map((name) => (
        <label key={name}>
          <input
            type="checkbox"
            disabled={disabled}
            checked={Object.hasOwn(chosen, name)}
            onChange={(event) => {
              const next = { ...chosen };
              if (event.target.checked)
                next[name] = available[name] ?? chosen[name] ?? 'string';
              else delete next[name];
              onChange(next);
            }}
          />
          {humanize(name)}{' '}
          <span className="authoring-hint">
            ({typeLabels[available[name] ?? chosen[name] ?? 'string']()})
          </span>
        </label>
      ))}
      <FieldProblems id={`${id}-problems`} diagnostics={diagnostics} />
    </fieldset>
  );
}

const durations = () => [
  { value: '60', label: m.authoring_duration_minutes() },
  { value: '3600', label: m.authoring_duration_hours() },
  { value: '86400', label: m.authoring_duration_days() },
];

function Duration({
  label,
  seconds,
  onChange,
  disabled,
  diagnostics,
}: {
  label: string;
  seconds: number;
  onChange(seconds: number): void;
  disabled?: boolean | undefined;
  diagnostics: WorkflowDiagnostic[];
}) {
  const unit =
    [86_400, 3600, 60].find(
      (item) => seconds % item === 0 && seconds >= item,
    ) ?? 60;

  return (
    <Field label={label} diagnostics={diagnostics}>
      {(props) => (
        <div className="authoring-duration">
          <Input
            {...props}
            type="number"
            min="1"
            disabled={disabled}
            value={Math.round(seconds / unit)}
            onChange={(event) =>
              onChange(Math.max(1, Number(event.target.value || 1)) * unit)
            }
          />
          <Select
            aria-label={m.authoring_duration_unit_label({ field: label })}
            disabled={disabled}
            value={String(unit)}
            onValueChange={(next) =>
              next && onChange(Math.round(seconds / unit) * Number(next))
            }
            options={durations()}
          />
        </div>
      )}
    </Field>
  );
}

/**
 * Edits one step with typed controls. Pickers offer only vocabulary entries and values that exist
 * at this point, so the builder cannot create references to later steps.
 */
export function StepForm({
  index,
  content,
  scope,
  vocabulary,
  diagnostics,
  disabled,
  onContent,
  openCode,
}: {
  index: number;
  content: WorkflowDraftContent;
  scope: ValueOption[];
  vocabulary: AuthoringVocabulary;
  diagnostics: WorkflowDiagnostic[];
  disabled?: boolean | undefined;
  onContent(next: WorkflowDraftContent): void;
  openCode(): void;
}) {
  const step = content.steps[index]!;
  const at = (field: string) =>
    diagnostics.filter(
      (item) => item.field === field || item.field?.startsWith(`${field}.`),
    );
  const set = (next: DraftStep) => onContent(updateStep(content, index, next));
  const actions = content.steps.filter((item) => item.kind === 'capability');

  switch (step.kind) {
    case 'read': {
      const source = vocabulary.reads.find(
        (item) => item.source === step.source,
      );

      return (
        <div className="authoring-step-form">
          <Field label={m.authoring_read_source()} diagnostics={at('source')}>
            {(props) => (
              <Select
                aria-label={m.authoring_read_source()}
                {...(props['aria-describedby']
                  ? { 'aria-describedby': props['aria-describedby'] }
                  : {})}
                disabled={disabled}
                value={step.source}
                placeholder={m.authoring_read_source_placeholder()}
                onValueChange={(next) => {
                  const chosen = vocabulary.reads.find(
                    (item) => item.source === next,
                  );
                  if (chosen)
                    set({
                      ...step,
                      source: chosen.source,
                      fields: { ...chosen.fields },
                    });
                }}
                options={vocabulary.reads.map((item) => ({
                  value: item.source,
                  label: limitedOption(item.label, item.executable),
                }))}
              />
            )}
          </Field>
          {source ? (
            <p className="authoring-hint">{source.description}</p>
          ) : null}
          <FieldChoices
            legend={m.authoring_read_fields()}
            available={source?.fields ?? {}}
            chosen={step.fields}
            disabled={disabled}
            diagnostics={at('fields')}
            onChange={(fields) => set({ ...step, fields })}
          />
        </div>
      );
    }
    case 'condition': {
      const names = [
        ...new Map(scope.map((item) => [item.field, item])).values(),
      ];
      const chosen = [...scope]
        .reverse()
        .find((item) => item.field === step.field);
      const type = chosen?.type ?? 'boolean';

      return (
        <div className="authoring-step-form">
          <Field
            label={m.authoring_condition_field()}
            diagnostics={at('field')}
          >
            {(props) => (
              <Select
                aria-label={m.authoring_condition_field()}
                {...(props['aria-describedby']
                  ? { 'aria-describedby': props['aria-describedby'] }
                  : {})}
                disabled={disabled}
                value={step.field}
                placeholder={m.authoring_condition_field_placeholder()}
                onValueChange={(next) => {
                  const option = names.find((item) => item.field === next);
                  if (option)
                    set({
                      ...step,
                      field: option.field,
                      equals:
                        option.type === 'boolean'
                          ? true
                          : emptyValue(option.type),
                    });
                }}
                options={names.map((item) => ({
                  value: item.field,
                  label:
                    item.source === 'step'
                      ? m.authoring_condition_option_step({
                          field: humanize(item.field),
                          step: item.stepId ?? '',
                        })
                      : item.source === 'input'
                        ? m.authoring_condition_option_input({
                            field: humanize(item.field),
                          })
                        : m.authoring_condition_option_evidence({
                            field: humanize(item.field),
                          }),
                }))}
              />
            )}
          </Field>
          <Field
            label={m.authoring_condition_equals()}
            diagnostics={at('equals')}
          >
            {(props) => (
              <ScalarInput
                {...props}
                aria-label={m.authoring_condition_equals()}
                disabled={disabled}
                type={type}
                value={step.equals}
                onChange={(equals) => set({ ...step, equals })}
              />
            )}
          </Field>
          <Field
            label={m.authoring_condition_otherwise()}
            diagnostics={at('onFalse')}
          >
            {() => (
              <Select
                aria-label={m.authoring_condition_otherwise()}
                disabled={disabled}
                value={step.onFalse}
                onValueChange={(next) =>
                  next && set({ ...step, onFalse: next as 'end' | 'escalate' })
                }
                options={[
                  {
                    value: 'end',
                    label: m.authoring_condition_otherwise_finish(),
                  },
                  {
                    value: 'escalate',
                    label: m.authoring_condition_otherwise_escalate(),
                  },
                ]}
              />
            )}
          </Field>
        </div>
      );
    }
    case 'capability': {
      const entry = vocabulary.capabilities.find(
        (item) =>
          item.capability === step.capability &&
          item.version === step.capabilityVersion,
      );
      const floor = entry?.minimumRisk ?? 'low';
      const order = ['low', 'medium', 'high'] as const;
      const approval = content.steps[index - 1]?.kind === 'approval';

      return (
        <div className="authoring-step-form">
          <Field
            label={m.authoring_action_label()}
            diagnostics={at('capability')}
          >
            {(props) => (
              <Select
                aria-label={m.authoring_action_label()}
                {...(props['aria-describedby']
                  ? { 'aria-describedby': props['aria-describedby'] }
                  : {})}
                disabled={disabled}
                value={`${step.capability}@${step.capabilityVersion}`}
                placeholder={m.authoring_action_placeholder()}
                onValueChange={(next) => {
                  const chosen = vocabulary.capabilities.find(
                    (item) => `${item.capability}@${item.version}` === next,
                  );
                  if (!chosen) return;
                  const updated: DraftStep = {
                    ...step,
                    capability: chosen.capability,
                    capabilityVersion: chosen.version,
                    targetKind: chosen.targetKind,
                    minimumRisk: chosen.minimumRisk,
                    parameters: Object.fromEntries(
                      Object.entries(chosen.parameters).map(([name, kind]) => [
                        name,
                        { source: 'literal' as const, value: emptyValue(kind) },
                      ]),
                    ),
                    expectedPostcondition: Object.fromEntries(
                      Object.entries(chosen.postcondition).map(
                        ([name, kind]) => [
                          name,
                          {
                            source: 'literal' as const,
                            value: emptyValue(kind),
                          },
                        ],
                      ),
                    ),
                  };
                  let changed = updateStep(content, index, updated);
                  const check = changed.steps[index + 1];
                  const evaluator = vocabulary.evaluators.find(
                    (item) => item.version === chosen.evaluators[0],
                  );
                  if (
                    check?.kind === 'verification' &&
                    check.forStep === step.id &&
                    evaluator
                  )
                    changed = updateStep(changed, index + 1, {
                      ...check,
                      evaluatorVersion: evaluator.version,
                      fields: { ...evaluator.fields },
                    });
                  onContent(changed);
                }}
                options={vocabulary.capabilities.map((item) => ({
                  value: `${item.capability}@${item.version}`,
                  label: limitedOption(item.label, item.executable),
                }))}
              />
            )}
          </Field>
          {entry ? (
            <div className="authoring-action-facts">
              <p>{entry.description}</p>
              <p>
                <strong>{m.authoring_action_approval_label()}</strong>{' '}
                {entry.approval}{' '}
                {approval
                  ? m.authoring_action_approval_present()
                  : m.authoring_action_approval_missing()}
              </p>
              <p>
                <strong>{m.authoring_action_changes_label()}</strong>{' '}
                {humanize(entry.targetKind)}
              </p>
              <p>
                <strong>{m.authoring_action_risk_label()}</strong>{' '}
                {minimumRisks[entry.minimumRisk]()}
              </p>
            </div>
          ) : null}
          <Field
            label={m.authoring_risk_label()}
            diagnostics={at('minimumRisk')}
          >
            {() => (
              <Select
                aria-label={m.authoring_risk_label()}
                disabled={disabled}
                value={step.minimumRisk}
                onValueChange={(next) =>
                  next &&
                  set({ ...step, minimumRisk: next as typeof step.minimumRisk })
                }
                options={order.map((risk) => ({
                  value: risk,
                  label: riskLabels[risk](),
                  disabled: order.indexOf(risk) < order.indexOf(floor),
                }))}
              />
            )}
          </Field>
          {Object.entries(entry?.parameters ?? {}).length ? (
            <fieldset className="authoring-values">
              <legend>{m.authoring_action_values()}</legend>
              {Object.entries(entry?.parameters ?? {}).map(([name, kind]) => (
                <ValuePicker
                  key={name}
                  label={humanize(name)}
                  type={kind}
                  value={step.parameters[name]}
                  scope={scope}
                  disabled={disabled}
                  diagnostics={at(`parameters.${name}`)}
                  onChange={(value) =>
                    set({
                      ...step,
                      parameters: { ...step.parameters, [name]: value },
                    })
                  }
                />
              ))}
            </fieldset>
          ) : null}
          <fieldset className="authoring-values">
            <legend>{m.authoring_action_expected()}</legend>
            {Object.entries(entry?.postcondition ?? {}).map(([name, kind]) => (
              <ValuePicker
                key={name}
                label={humanize(name)}
                type={kind}
                value={step.expectedPostcondition[name]}
                scope={scope}
                disabled={disabled}
                diagnostics={at(`expectedPostcondition.${name}`)}
                onChange={(value) =>
                  set({
                    ...step,
                    expectedPostcondition: {
                      ...step.expectedPostcondition,
                      [name]: value,
                    },
                  })
                }
              />
            ))}
            <FieldProblems
              id={`${step.id}-expected`}
              diagnostics={diagnostics.filter(
                (item) => item.field === 'expectedPostcondition',
              )}
            />
          </fieldset>
        </div>
      );
    }
    case 'approval':
      return (
        <div className="authoring-step-form">
          <Field
            label={m.authoring_approval_for()}
            hint={m.authoring_approval_for_hint()}
            diagnostics={at('forStep')}
          >
            {(props) => (
              <Select
                aria-label={m.authoring_approval_for()}
                {...(props['aria-describedby']
                  ? { 'aria-describedby': props['aria-describedby'] }
                  : {})}
                disabled={disabled}
                value={step.forStep}
                placeholder={m.authoring_action_placeholder()}
                onValueChange={(next) =>
                  next && set({ ...step, forStep: next })
                }
                options={actions.map((item) => ({
                  value: item.id,
                  label: item.id,
                }))}
              />
            )}
          </Field>
          <Duration
            label={m.authoring_approval_expires()}
            seconds={step.expiresAfterSeconds}
            disabled={disabled}
            diagnostics={at('expiresAfterSeconds')}
            onChange={(expiresAfterSeconds) =>
              set({ ...step, expiresAfterSeconds })
            }
          />
        </div>
      );
    case 'human_task':
      return (
        <div className="authoring-step-form">
          <TaskTarget
            label={m.authoring_coordination_assignee()}
            value={step.assignee}
            disabled={disabled}
            onChange={(assignee) => set({ ...step, assignee })}
          />
          <Field
            label={m.authoring_coordination_instructions()}
            diagnostics={at('instructions')}
          >
            {(props) => (
              <Textarea
                {...props}
                value={step.instructions}
                disabled={disabled}
                maxLength={2000}
                onChange={(event) =>
                  set({ ...step, instructions: event.target.value })
                }
              />
            )}
          </Field>
          <Field
            label={m.authoring_coordination_choices()}
            diagnostics={at('choices')}
          >
            {(props) => (
              <Textarea
                {...props}
                value={step.choices.join('\n')}
                disabled={disabled}
                onChange={(event) =>
                  set({ ...step, choices: event.target.value.split('\n') })
                }
              />
            )}
          </Field>
          <Field label={m.authoring_coordination_evidence()}>
            {() => (
              <Select
                aria-label={m.authoring_coordination_evidence()}
                value={step.evidence}
                disabled={disabled}
                options={[
                  { value: 'text', label: m.authoring_coordination_text() },
                  { value: 'link', label: m.authoring_coordination_link() },
                  { value: 'record', label: m.authoring_coordination_record() },
                ]}
                onValueChange={(evidence) => {
                  if (evidence) set({ ...step, evidence });
                }}
              />
            )}
          </Field>
          <Duration
            label={m.authoring_coordination_due()}
            seconds={step.dueAfterSeconds}
            disabled={disabled}
            diagnostics={at('dueAfterSeconds')}
            onChange={(dueAfterSeconds) => set({ ...step, dueAfterSeconds })}
          />
          <TaskTarget
            label={m.authoring_coordination_fallback()}
            value={step.escalationTarget}
            disabled={disabled}
            onChange={(escalationTarget) => set({ ...step, escalationTarget })}
          />
        </div>
      );
    case 'event_wait':
      return (
        <div className="authoring-step-form">
          <Field
            label={m.authoring_coordination_event_type()}
            diagnostics={at('eventType')}
          >
            {(props) => (
              <Input
                {...props}
                value={step.eventType}
                disabled={disabled}
                onChange={(event) =>
                  set({ ...step, eventType: event.target.value })
                }
              />
            )}
          </Field>
          <ValuePicker
            label={m.authoring_coordination_correlation()}
            type="string"
            value={step.correlation}
            scope={scope}
            disabled={disabled}
            diagnostics={at('correlation')}
            onChange={(correlation) => set({ ...step, correlation })}
          />
          <FieldListEditor
            label={m.authoring_read_fields()}
            fields={step.fields}
            disabled={disabled}
            onChange={(fields) => set({ ...step, fields })}
          />
          <Duration
            label={m.authoring_coordination_timeout()}
            seconds={step.timeoutSeconds}
            disabled={disabled}
            diagnostics={at('timeoutSeconds')}
            onChange={(timeoutSeconds) => set({ ...step, timeoutSeconds })}
          />
          <Field label={m.authoring_coordination_on_timeout()}>
            {() => (
              <Select
                aria-label={m.authoring_coordination_on_timeout()}
                value={step.onTimeout}
                disabled={disabled}
                options={[
                  {
                    value: 'escalate',
                    label: m.authoring_coordination_escalate(),
                  },
                  { value: 'end', label: m.authoring_coordination_end() },
                ]}
                onValueChange={(onTimeout) => {
                  if (onTimeout) set({ ...step, onTimeout });
                }}
              />
            )}
          </Field>
        </div>
      );
    case 'wait':
      return (
        <div className="authoring-step-form">
          <Duration
            label={m.authoring_wait_for()}
            seconds={step.seconds}
            disabled={disabled}
            diagnostics={at('seconds')}
            onChange={(seconds) => set({ ...step, seconds })}
          />
        </div>
      );
    case 'verification': {
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
      const choices = vocabulary.evaluators.filter(
        (item) => !capability || capability.evaluators.includes(item.version),
      );

      return (
        <div className="authoring-step-form">
          <Field label={m.authoring_check_for()} diagnostics={at('forStep')}>
            {(props) => (
              <Select
                aria-label={m.authoring_check_for()}
                {...(props['aria-describedby']
                  ? { 'aria-describedby': props['aria-describedby'] }
                  : {})}
                disabled={disabled}
                value={step.forStep}
                placeholder={m.authoring_action_placeholder()}
                onValueChange={(next) =>
                  next && set({ ...step, forStep: next })
                }
                options={actions.map((item) => ({
                  value: item.id,
                  label: item.id,
                }))}
              />
            )}
          </Field>
          <Field
            label={m.authoring_step_kind_check()}
            diagnostics={at('evaluatorVersion')}
          >
            {(props) => (
              <Select
                aria-label={m.authoring_step_kind_check()}
                {...(props['aria-describedby']
                  ? { 'aria-describedby': props['aria-describedby'] }
                  : {})}
                disabled={disabled}
                value={step.evaluatorVersion}
                placeholder={m.authoring_check_placeholder()}
                onValueChange={(next) => {
                  const chosen = vocabulary.evaluators.find(
                    (item) => item.version === next,
                  );
                  if (chosen)
                    set({
                      ...step,
                      evaluatorVersion: chosen.version,
                      fields: { ...chosen.fields },
                    });
                }}
                options={choices.map((item) => ({
                  value: item.version,
                  label: limitedOption(item.label, item.executable),
                }))}
              />
            )}
          </Field>
          <FieldChoices
            legend={m.authoring_check_fields()}
            available={evaluator?.fields ?? {}}
            chosen={step.fields}
            disabled={disabled}
            diagnostics={at('fields')}
            onChange={(fields) => set({ ...step, fields })}
          />
          <Field
            label={m.authoring_check_time_limit()}
            diagnostics={at('maxDurationSeconds')}
          >
            {(props) => (
              <Input
                {...props}
                type="number"
                min="1"
                max="300"
                disabled={disabled}
                value={step.maxDurationSeconds}
                onChange={(event) =>
                  set({
                    ...step,
                    maxDurationSeconds: Number(event.target.value || 1),
                  })
                }
              />
            )}
          </Field>
          <Field
            label={m.authoring_coordination_rechecks()}
            diagnostics={at('recheck')}
          >
            {(props) => (
              <Input
                {...props}
                type="number"
                min="1"
                max="10"
                disabled={disabled}
                value={step.recheck?.attempts ?? 1}
                onChange={(event) => {
                  const attempts = Number(event.target.value || 1);
                  set({
                    ...step,
                    recheck:
                      attempts > 1
                        ? {
                            attempts,
                            intervalSeconds: step.recheck?.intervalSeconds ?? 5,
                          }
                        : undefined,
                  });
                }}
              />
            )}
          </Field>
          {step.recheck ? (
            <Field label={m.authoring_coordination_recheck_interval()}>
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  min="1"
                  max="300"
                  disabled={disabled}
                  value={step.recheck?.intervalSeconds ?? 5}
                  onChange={(event) =>
                    set({
                      ...step,
                      recheck: {
                        attempts: step.recheck?.attempts ?? 2,
                        intervalSeconds: Number(event.target.value || 1),
                      },
                    })
                  }
                />
              )}
            </Field>
          ) : null}
        </div>
      );
    }
    case 'escalation':
      return (
        <div className="authoring-step-form">
          <Field
            label={m.authoring_escalation_reason()}
            diagnostics={at('reason')}
          >
            {(props) => (
              <Input
                {...props}
                disabled={disabled}
                value={step.reason}
                onChange={(event) =>
                  set({ ...step, reason: event.target.value })
                }
              />
            )}
          </Field>
        </div>
      );
    case 'end':
      return (
        <div className="authoring-step-form">
          <Field
            label={m.authoring_finish_outcome()}
            diagnostics={at('outcome')}
          >
            {(props) => (
              <Input
                {...props}
                disabled={disabled}
                value={step.outcome}
                onChange={(event) =>
                  set({ ...step, outcome: event.target.value })
                }
              />
            )}
          </Field>
        </div>
      );
    case 'code':
      return (
        <div className="authoring-step-form">
          <dl className="authoring-code-summary">
            <div>
              <dt>{m.authoring_code_summary_uses()}</dt>
              <dd>
                {scope.length
                  ? formatList(scope.map((item) => valueLabel(item)))
                  : m.authoring_code_summary_uses_empty()}
              </dd>
            </div>
            <div>
              <dt>{m.authoring_code_summary_returns()}</dt>
              <dd>
                {Object.keys(step.fields).length
                  ? formatList(
                      Object.entries(step.fields).map(([name, kind]) =>
                        m.authoring_code_summary_field({
                          field: humanize(name),
                          type: typeLabels[kind](),
                        }),
                      ),
                    )
                  : m.authoring_code_summary_returns_empty()}
              </dd>
            </div>
            <div>
              <dt>{m.authoring_code_summary_requests()}</dt>
              <dd>
                {step.grants.length
                  ? formatList(step.grants)
                  : m.authoring_code_summary_requests_empty()}
              </dd>
            </div>
          </dl>
          <FieldProblems
            id={`${step.id}-code`}
            diagnostics={diagnostics.filter(
              (item) => item.field !== null && item.field !== 'kind',
            )}
          />
          <Button variant="outline" onClick={openCode}>
            {disabled
              ? m.authoring_code_step_view()
              : m.authoring_code_step_edit()}
          </Button>
        </div>
      );
  }
}

/** Uses current workspace people and role identities for a human-task handoff. */
function TaskTarget({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: Extract<DraftStep, { kind: 'human_task' }>['assignee'];
  disabled?: boolean | undefined;
  onChange: (
    value: Extract<DraftStep, { kind: 'human_task' }>['assignee'],
  ) => void;
}) {
  const { organizationId } = useParams({ strict: false });
  const members = useQuery({
    ...membersOptions(organizationId ?? ''),
    enabled: !!organizationId,
  });
  const people = (members.data ?? []).filter(
    (member) => member.status === 'active',
  );
  const roles = Array.from(
    new Map(people.map((member) => [member.role.id, member.role])).values(),
  );

  return (
    <Field label={label}>
      {() => (
        <div>
          <Select
            aria-label={label}
            value={value.kind}
            disabled={disabled}
            options={[
              { value: 'person', label: m.authoring_coordination_person() },
              { value: 'role', label: m.authoring_coordination_role() },
            ]}
            onValueChange={(kind) => {
              if (kind)
                onChange(
                  kind === 'person'
                    ? { kind, id: people[0]?.userId ?? '' }
                    : { kind, key: 'member' },
                );
            }}
          />
          {value.kind === 'person' ? (
            <PersonPicker
              label={
                people.find((person) => person.userId === value.id)?.name ??
                m.authoring_coordination_assignee()
              }
              title={label}
              people={people.map((person) => ({
                id: person.userId,
                name:
                  person.name || person.email || m.decisions_member_fallback(),
                detail: person.email,
              }))}
              disabled={disabled || members.isPending}
              onSelect={(id) => onChange({ kind: 'person', id })}
            />
          ) : (
            <Select
              aria-label={label}
              value={value.key}
              options={roles.map((role) => ({
                value: role.id,
                label: role.name,
              }))}
              disabled={disabled}
              onValueChange={(key) => {
                if (key) onChange({ kind: 'role', key });
              }}
            />
          )}
          {members.isError ? (
            <p role="alert">{m.authoring_coordination_unavailable()}</p>
          ) : null}
        </div>
      )}
    </Field>
  );
}
