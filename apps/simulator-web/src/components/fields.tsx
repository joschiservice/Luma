import {
  Field,
  FieldDescription,
  FieldLabel,
} from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import {
  Select,
  type SelectOption,
} from '@luma/ui/components/primitives/select';
import { type ReactNode, useId, useState } from 'react';

import { fromPercent, toPercent } from '../lib/format';

/** A labeled select; the label names the trigger and its option list. */
export function SelectField<Value extends string>({
  label,
  value,
  options,
  onChange,
  description,
  disabled,
  className,
}: {
  label: string;
  value: Value | null;
  options: readonly SelectOption<Value>[];
  onChange: (value: Value) => void;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();

  return (
    <Field className={className}>
      <FieldLabel id={`${id}-label`}>{label}</FieldLabel>
      <Select
        aria-labelledby={`${id}-label`}
        {...(description ? { 'aria-describedby': `${id}-description` } : {})}
        value={value}
        options={options}
        disabled={disabled ?? false}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
      />
      {description ? (
        <FieldDescription id={`${id}-description`}>
          {description}
        </FieldDescription>
      ) : null}
    </Field>
  );
}

const display = (value: number | undefined) =>
  value === undefined ? '' : String(value);

/**
 * A labeled number input that reports only valid numbers within its range. It keeps the
 * person's partial text, such as "1." or an empty field, until it parses, and follows outside
 * changes such as a slider or a newly loaded profile. Pass `optional` to report an empty field
 * as undefined.
 */
export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  description,
  optional = false,
  disabled,
  className,
}: {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Shown after the input and read with its label, such as "ms" or "%". */
  unit?: string;
  description?: ReactNode;
  optional?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const [text, setText] = useState(display(value));
  const [shown, setShown] = useState(value);
  if (value !== shown) {
    setShown(value);
    if (text === '' ? value !== undefined : Number(text) !== value)
      setText(display(value));
  }
  const parsed = text.trim() === '' ? undefined : Number(text);
  const invalid =
    parsed === undefined
      ? !optional
      : !Number.isFinite(parsed) ||
        (min !== undefined && parsed < min) ||
        (max !== undefined && parsed > max);
  const describedBy = [
    unit ? `${id}-unit` : null,
    description ? `${id}-description` : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Field className={className}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="sim-number">
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          value={text}
          min={min}
          max={max}
          step={step}
          disabled={disabled ?? false}
          aria-invalid={invalid || undefined}
          {...(describedBy ? { 'aria-describedby': describedBy } : {})}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setText(next);
            const number = next.trim() === '' ? undefined : Number(next);
            if (number === undefined) {
              if (optional) onChange(undefined);

              return;
            }
            if (
              Number.isFinite(number) &&
              (min === undefined || number >= min) &&
              (max === undefined || number <= max)
            )
              onChange(number);
          }}
        />
        {unit ? (
          <span id={`${id}-unit`} className="sim-unit">
            {unit}
          </span>
        ) : null}
      </div>
      {description ? (
        <FieldDescription id={`${id}-description`}>
          {description}
        </FieldDescription>
      ) : null}
      {invalid ? (
        <FieldDescription className="sim-error-text">
          {parsed === undefined
            ? 'Enter a number.'
            : `Enter a number${min !== undefined ? ` from ${min}` : ''}${max !== undefined ? ` to ${max}` : ''}.`}
        </FieldDescription>
      ) : null}
    </Field>
  );
}

/**
 * Edits a share from 0 to 1 as a percentage, with a slider for quick changes and a number
 * field for exact values. `maxPercent` limits the slider; the number accepts up to 100%.
 */
export function RateField({
  label,
  value,
  onChange,
  maxPercent = 100,
  step = 0.1,
  description,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  maxPercent?: number;
  step?: number;
  description?: ReactNode;
}) {
  const id = useId();
  const percent = toPercent(value);

  return (
    <div className="sim-rate">
      <NumberField
        label={label}
        value={percent}
        min={0}
        max={100}
        step={step}
        unit="%"
        description={description}
        onChange={(next) => onChange(fromPercent(next ?? 0))}
      />
      <input
        id={`${id}-slider`}
        type="range"
        className="sim-slider"
        aria-label={`${label}, slider`}
        aria-valuetext={`${percent}%`}
        min={0}
        max={Math.max(maxPercent, percent)}
        step={step}
        value={percent}
        onChange={(event) =>
          onChange(fromPercent(event.currentTarget.valueAsNumber))
        }
      />
    </div>
  );
}
