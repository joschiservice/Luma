import type {
  AuthoringVocabulary,
  DraftStep,
  ValueOption,
  WorkflowDiagnostic,
  WorkflowDraftContent,
} from '@luma/api-contract';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { Plus, Trash2 } from 'lucide-react';
import { type ReactNode, useId } from 'react';

import {
  emptyValue,
  type FieldType,
  humanize,
  type StepValue,
  updateStep,
  valueKey,
  valueLabel,
} from './draft-model';

const fieldTypes: { value: FieldType; label: string }[] = [
  { value: 'string', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Yes or no' },
  { value: 'null', label: 'Empty' },
];

const typeNames: Record<FieldType, string> = {
  string: 'text',
  number: 'number',
  boolean: 'yes or no',
  null: 'empty',
};

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
        aria-label={props['aria-label'] ?? 'Value'}
        {...(props['aria-describedby']
          ? { 'aria-describedby': props['aria-describedby'] }
          : {})}
        disabled={disabled}
        value={value === true ? 'yes' : 'no'}
        onValueChange={(next) => onChange(next === 'yes')}
        options={[
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ]}
      />
    );
  if (type === 'null') return <p className="authoring-hint">Empty</p>;

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
export function ValuePicker({
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
      hint={type ? `Needs ${typeNames[type]}.` : undefined}
      diagnostics={diagnostics}
    >
      {(props) => (
        <div className="authoring-value-picker">
          <Select
            aria-label={`${label}: source`}
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
              { value: 'literal', label: 'A fixed value' },
              ...options.map((option) => ({
                value: valueKey(option),
                label: valueLabel(option),
              })),
              ...(!known && value
                ? [
                    {
                      value: current,
                      label: `${valueLabel(value)} (not available here)`,
                      disabled: true,
                    },
                  ]
                : []),
            ]}
          />
          {value?.source === 'literal' || !value ? (
            <ScalarInput
              {...props}
              aria-label={`${label}: value`}
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
      {entries.length ? null : <p className="authoring-hint">None yet.</p>}
      {entries.map(([name, type], index) => (
        <div key={index} className="authoring-field-row">
          <Input
            aria-label={`${label} ${index + 1} name`}
            disabled={disabled}
            value={name}
            onChange={(event) => rename(name, event.target.value)}
          />
          <Select
            aria-label={`${label} ${index + 1} type`}
            disabled={disabled}
            value={type}
            onValueChange={(next) =>
              next && onChange({ ...fields, [name]: next as FieldType })
            }
            options={fieldTypes}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove ${name || `${label} ${index + 1}`}`}
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
        <Plus aria-hidden="true" /> Add field
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
        <p className="authoring-hint">Choose a source first.</p>
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
            ({typeNames[available[name] ?? chosen[name] ?? 'string']})
          </span>
        </label>
      ))}
      <FieldProblems id={`${id}-problems`} diagnostics={diagnostics} />
    </fieldset>
  );
}

const durations = [
  { value: '60', label: 'Minutes' },
  { value: '3600', label: 'Hours' },
  { value: '86400', label: 'Days' },
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
            aria-label={`${label} unit`}
            disabled={disabled}
            value={String(unit)}
            onValueChange={(next) =>
              next && onChange(Math.round(seconds / unit) * Number(next))
            }
            options={durations}
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
          <Field label="Data source" diagnostics={at('source')}>
            {(props) => (
              <Select
                aria-label="Data source"
                {...(props['aria-describedby']
                  ? { 'aria-describedby': props['aria-describedby'] }
                  : {})}
                disabled={disabled}
                value={step.source}
                placeholder="Choose a data source"
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
                  label: `${item.label}${item.executable ? '' : ' · can’t run here'}`,
                }))}
              />
            )}
          </Field>
          {source ? (
            <p className="authoring-hint">{source.description}</p>
          ) : null}
          <FieldChoices
            legend="Fields to read"
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
          <Field label="Field to check" diagnostics={at('field')}>
            {(props) => (
              <Select
                aria-label="Field to check"
                {...(props['aria-describedby']
                  ? { 'aria-describedby': props['aria-describedby'] }
                  : {})}
                disabled={disabled}
                value={step.field}
                placeholder="Choose a field"
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
                  label: `${humanize(item.field)} · ${item.source === 'step' ? `from ${item.stepId}` : item.source}`,
                }))}
              />
            )}
          </Field>
          <Field label="Continue when it is" diagnostics={at('equals')}>
            {(props) => (
              <ScalarInput
                {...props}
                aria-label="Continue when it is"
                disabled={disabled}
                type={type}
                value={step.equals}
                onChange={(equals) => set({ ...step, equals })}
              />
            )}
          </Field>
          <Field label="Otherwise" diagnostics={at('onFalse')}>
            {() => (
              <Select
                aria-label="Otherwise"
                disabled={disabled}
                value={step.onFalse}
                onValueChange={(next) =>
                  next && set({ ...step, onFalse: next as 'end' | 'escalate' })
                }
                options={[
                  { value: 'end', label: 'Finish the run' },
                  { value: 'escalate', label: 'Escalate to a person' },
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
          <Field label="Action" diagnostics={at('capability')}>
            {(props) => (
              <Select
                aria-label="Action"
                {...(props['aria-describedby']
                  ? { 'aria-describedby': props['aria-describedby'] }
                  : {})}
                disabled={disabled}
                value={`${step.capability}@${step.capabilityVersion}`}
                placeholder="Choose an action"
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
                  label: `${item.label}${item.executable ? '' : ' · can’t run here'}`,
                }))}
              />
            )}
          </Field>
          {entry ? (
            <div className="authoring-action-facts">
              <p>{entry.description}</p>
              <p>
                <strong>Approval:</strong> {entry.approval}{' '}
                {approval
                  ? 'An approval step before it asks a person first.'
                  : 'Add an approval step before it to always ask a person.'}
              </p>
              <p>
                <strong>Changes:</strong> a {humanize(entry.targetKind)}.{' '}
                <strong>Risk:</strong> at least {entry.minimumRisk}.
              </p>
            </div>
          ) : null}
          <Field label="Risk" diagnostics={at('minimumRisk')}>
            {() => (
              <Select
                aria-label="Risk"
                disabled={disabled}
                value={step.minimumRisk}
                onValueChange={(next) =>
                  next &&
                  set({ ...step, minimumRisk: next as typeof step.minimumRisk })
                }
                options={order.map((risk) => ({
                  value: risk,
                  label: risk.charAt(0).toUpperCase() + risk.slice(1),
                  disabled: order.indexOf(risk) < order.indexOf(floor),
                }))}
              />
            )}
          </Field>
          {Object.entries(entry?.parameters ?? {}).length ? (
            <fieldset className="authoring-values">
              <legend>Values for the action</legend>
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
            <legend>Expected result</legend>
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
            label="Approves"
            hint="An approval must come right before the action it approves."
            diagnostics={at('forStep')}
          >
            {(props) => (
              <Select
                aria-label="Approves"
                {...(props['aria-describedby']
                  ? { 'aria-describedby': props['aria-describedby'] }
                  : {})}
                disabled={disabled}
                value={step.forStep}
                placeholder="Choose an action"
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
            label="Time to decide"
            seconds={step.expiresAfterSeconds}
            disabled={disabled}
            diagnostics={at('expiresAfterSeconds')}
            onChange={(expiresAfterSeconds) =>
              set({ ...step, expiresAfterSeconds })
            }
          />
        </div>
      );
    case 'wait':
      return (
        <div className="authoring-step-form">
          <Duration
            label="Wait for"
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
          <Field label="Checks the result of" diagnostics={at('forStep')}>
            {(props) => (
              <Select
                aria-label="Checks the result of"
                {...(props['aria-describedby']
                  ? { 'aria-describedby': props['aria-describedby'] }
                  : {})}
                disabled={disabled}
                value={step.forStep}
                placeholder="Choose an action"
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
          <Field label="Result check" diagnostics={at('evaluatorVersion')}>
            {(props) => (
              <Select
                aria-label="Result check"
                {...(props['aria-describedby']
                  ? { 'aria-describedby': props['aria-describedby'] }
                  : {})}
                disabled={disabled}
                value={step.evaluatorVersion}
                placeholder="Choose a check"
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
                  label: `${item.label}${item.executable ? '' : ' · can’t run here'}`,
                }))}
              />
            )}
          </Field>
          <FieldChoices
            legend="Fields to confirm"
            available={evaluator?.fields ?? {}}
            chosen={step.fields}
            disabled={disabled}
            diagnostics={at('fields')}
            onChange={(fields) => set({ ...step, fields })}
          />
          <Field
            label="Time limit in seconds"
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
        </div>
      );
    }
    case 'escalation':
      return (
        <div className="authoring-step-form">
          <Field label="Reason shown to the person" diagnostics={at('reason')}>
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
          <Field label="Outcome" diagnostics={at('outcome')}>
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
              <dt>Reads</dt>
              <dd>
                {scope.length
                  ? scope.map((item) => valueLabel(item)).join(', ')
                  : 'No inputs yet'}
              </dd>
            </div>
            <div>
              <dt>Returns</dt>
              <dd>
                {Object.entries(step.fields)
                  .map(
                    ([name, kind]) => `${humanize(name)} (${typeNames[kind]})`,
                  )
                  .join(', ') || 'Nothing declared'}
              </dd>
            </div>
            <div>
              <dt>Can request</dt>
              <dd>{step.grants.join(', ') || 'No other steps'}</dd>
            </div>
          </dl>
          <FieldProblems
            id={`${step.id}-code`}
            diagnostics={diagnostics.filter(
              (item) => item.field !== null && item.field !== 'kind',
            )}
          />
          <Button variant="outline" onClick={openCode}>
            {disabled ? 'View Code Step' : 'Edit Code Step'}
          </Button>
        </div>
      );
  }
}
