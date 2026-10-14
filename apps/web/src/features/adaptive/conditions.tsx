import type { CollectionCondition, CollectionWhere } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Field, FieldLabel } from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import {
  type ConditionField,
  describeCondition,
  operatorLabel,
} from '@luma/ui/lib/collection-conditions';
import { Trash2 } from 'lucide-react';
import { useId } from 'react';

import {
  editableCondition,
  editableOperators,
  type EditorField,
  initialValue,
  invalidConditions,
  newCondition,
  parseValue,
  valueInput,
  valueText,
} from './query-fields';

/**
 * Edits a view's conditions as rows of field, operator and value. Conditions the rows cannot
 * represent, such as ranges or unknown fields, stay listed with a summary and can be removed.
 */
export function ConditionRows({
  fields,
  where,
  label,
  optionLabel,
  allowed,
  onChange,
}: {
  fields: readonly EditorField[];
  where: CollectionWhere;
  label: (field: string) => string;
  optionLabel: (field: EditorField, option: string) => string;
  allowed: (field: EditorField) => boolean;
  onChange: (where: CollectionWhere) => void;
}) {
  const invalid = invalidConditions(fields, where.conditions);
  const replace = (index: number, next: CollectionCondition | null) =>
    onChange({
      ...where,
      conditions: where.conditions.flatMap((item, at) =>
        at !== index ? [item] : next ? [next] : [],
      ),
    });
  const usable = fields.filter(allowed);

  return (
    <>
      {where.conditions.length > 1 ? (
        <Field>
          <FieldLabel>{m.ui_condition_match_label()}</FieldLabel>
          <Select
            aria-label={m.ui_condition_match_label()}
            value={where.match}
            options={[
              { value: 'all', label: m.ui_condition_match_all() },
              { value: 'any', label: m.ui_condition_match_any() },
            ]}
            onValueChange={(match) => {
              if (match) onChange({ ...where, match });
            }}
          />
        </Field>
      ) : null}
      {where.conditions.map((condition, index) => (
        <ConditionRow
          key={`${condition.field}:${index}`}
          fields={usable}
          field={fields.find((item) => item.id === condition.field)}
          condition={condition}
          invalid={invalid.includes(index)}
          label={label}
          optionLabel={optionLabel}
          onChange={(next) => replace(index, next)}
          onRemove={() => replace(index, null)}
        />
      ))}
      {invalid.length ? (
        <Alert tone="warning" role="alert">
          {m.adaptive_conditions_invalid()}
        </Alert>
      ) : null}
      <Select
        aria-label={m.adaptive_add_condition()}
        value={null}
        placeholder={m.adaptive_add_condition()}
        disabled={where.conditions.length >= 20}
        options={fields.map((field) => ({
          value: field.id,
          label: label(field.id),
          disabled: !allowed(field),
        }))}
        onValueChange={(id) => {
          const field = usable.find((item) => item.id === id);
          if (field)
            onChange({
              ...where,
              conditions: [...where.conditions, newCondition(field)],
            });
        }}
      />
    </>
  );
}

function ConditionRow({
  fields,
  field,
  condition,
  invalid,
  label,
  optionLabel,
  onChange,
  onRemove,
}: {
  fields: readonly EditorField[];
  field: EditorField | undefined;
  condition: CollectionCondition;
  invalid: boolean;
  label: (field: string) => string;
  optionLabel: (field: EditorField, option: string) => string;
  onChange: (condition: CollectionCondition) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const remove = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={m.adaptive_remove()}
      onClick={onRemove}
    >
      <Trash2 aria-hidden="true" />
    </Button>
  );
  if (!field || !editableCondition(field, condition)) {
    const known: ConditionField = {
      id: condition.field,
      label: label(condition.field),
      type: field?.type ?? 'text',
      operators: field?.operators ?? [],
    };

    return (
      <div className="adaptive-condition" data-invalid={invalid || undefined}>
        <div className="adaptive-condition-fixed">
          <span>{describeCondition(known, condition)}</span>
          {remove}
        </div>
        <p>{m.adaptive_condition_fixed()}</p>
      </div>
    );
  }
  const input = valueInput(field, condition.op);
  const set = (value: CollectionCondition['value']) =>
    onChange(
      value === undefined
        ? { field: condition.field, op: condition.op }
        : { ...condition, value },
    );
  const options = field.options ?? [];
  const chosen = Array.isArray(condition.value) ? condition.value : [];

  return (
    <div className="adaptive-condition" data-invalid={invalid || undefined}>
      <div className="adaptive-filter">
        <Field>
          <FieldLabel>{m.adaptive_field()}</FieldLabel>
          <Select
            aria-label={m.adaptive_field()}
            value={field.id}
            options={[
              ...fields.map((item) => ({
                value: item.id,
                label: label(item.id),
              })),
              ...(fields.some((item) => item.id === field.id)
                ? []
                : [{ value: field.id, label: label(field.id) }]),
            ]}
            onValueChange={(next) => {
              const picked = fields.find((item) => item.id === next);
              if (picked && picked.id !== field.id)
                onChange(newCondition(picked));
            }}
          />
        </Field>
        <Field>
          <FieldLabel>{m.adaptive_filter_operator()}</FieldLabel>
          <Select
            aria-label={m.adaptive_filter_operator()}
            value={condition.op}
            options={editableOperators(field).map((op) => ({
              value: op,
              label: operatorLabel(op),
            }))}
            onValueChange={(op) => {
              if (!op || op === condition.op) return;
              const kept =
                valueInput(field, op) === input ? condition.value : undefined;
              const value = kept ?? initialValue(field, op);
              onChange(
                value === undefined
                  ? { field: field.id, op }
                  : { field: field.id, op, value },
              );
            }}
          />
        </Field>
        {remove}
      </div>
      {input === 'none' ? null : input === 'list' && options.length ? (
        <fieldset className="adaptive-checks">
          <legend className="sr-only">{m.adaptive_value()}</legend>
          {options.map((option) => (
            <label className="adaptive-check" key={option}>
              <input
                type={field.ownerFilter ? 'radio' : 'checkbox'}
                name={id}
                checked={chosen.includes(option)}
                onChange={(event) =>
                  set(
                    field.ownerFilter
                      ? [option]
                      : event.target.checked
                        ? [...chosen, option]
                        : chosen.filter((item) => item !== option).length
                          ? chosen.filter((item) => item !== option)
                          : undefined,
                  )
                }
              />
              {optionLabel(field, option)}
            </label>
          ))}
        </fieldset>
      ) : field.type === 'boolean' ? (
        <Field>
          <FieldLabel>{m.adaptive_value()}</FieldLabel>
          <Select
            aria-label={m.adaptive_value()}
            value={condition.value === false ? 'false' : 'true'}
            options={[
              { value: 'true', label: m.adaptive_yes() },
              { value: 'false', label: m.adaptive_no() },
            ]}
            onValueChange={(value) => set(value === 'true')}
          />
        </Field>
      ) : input === 'single' && options.length ? (
        <Field>
          <FieldLabel>{m.adaptive_value()}</FieldLabel>
          <Select
            aria-label={m.adaptive_value()}
            value={typeof condition.value === 'string' ? condition.value : null}
            options={options.map((option) => ({
              value: option,
              label: optionLabel(field, option),
            }))}
            onValueChange={(value) => set(value ?? undefined)}
          />
        </Field>
      ) : (
        <Field>
          <FieldLabel htmlFor={`${id}-value`}>{m.adaptive_value()}</FieldLabel>
          <ConditionText
            key={condition.op}
            id={`${id}-value`}
            field={field}
            condition={condition}
            onChange={set}
          />
          {input === 'list' ? (
            <p>
              {field.ownerFilter
                ? m.adaptive_condition_single_hint()
                : m.adaptive_condition_values_hint()}
            </p>
          ) : null}
        </Field>
      )}
    </div>
  );
}

/** Free-text value entry; list operators read comma-separated values. */
function ConditionText({
  id,
  field,
  condition,
  onChange,
}: {
  id: string;
  field: EditorField;
  condition: CollectionCondition;
  onChange: (value: CollectionCondition['value']) => void;
}) {
  const single = valueInput(field, condition.op) === 'single';

  return (
    <Input
      id={id}
      type={
        single && field.type === 'number'
          ? 'number'
          : single && field.type === 'date'
            ? 'date'
            : 'text'
      }
      defaultValue={valueText(condition.value)}
      onChange={(event) =>
        onChange(parseValue(field, condition.op, event.target.value))
      }
    />
  );
}
