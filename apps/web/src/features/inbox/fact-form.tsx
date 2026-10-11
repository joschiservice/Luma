import {
  type FactValue,
  factValueSchema,
  type RecordRef,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { useId } from 'react';

import {
  amountRoleLabels,
  dateRoleLabels,
  factKindLabels,
  factKinds,
  partyRoleLabels,
  referenceRoleLabels,
} from './presentation';
import { recordName } from './records';

type Kind = FactValue['kind'];

/** A starting value for a fact of `kind`, prefilled from selected source text where it fits. */
export function emptyFact(kind: Kind, text = ''): FactValue {
  const quote = text.trim().slice(0, 200);
  switch (kind) {
    case 'party':
      return { kind, role: 'supplier', name: quote, email: null };
    case 'reference':
      return { kind, role: 'purchase_order', text: quote };
    case 'line':
      return {
        kind,
        sku: null,
        description: quote || null,
        quantity: null,
        unit: null,
        unitPrice: null,
      };
    case 'date':
      return {
        kind,
        role: 'delivery',
        date: /^\d{4}-\d{2}-\d{2}$/.test(quote) ? quote : '',
      };
    case 'amount':
      return {
        kind,
        role: 'total',
        money: {
          amount: /^-?\d+(\.\d+)?$/.test(quote) ? quote : '',
          currency: 'EUR',
        },
      };
  }
}

/** Validates a fact value as the API will; returns the normalized value or null. */
export function validFact(value: FactValue) {
  const parsed = factValueSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}

const orNull = (value: string) => (value.trim() ? value : null);

function Text({
  label,
  value,
  onChange,
  required = false,
  type = 'text',
  maxLength = 200,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  type?: string;
  maxLength?: number;
  inputMode?: 'decimal' | 'text';
}) {
  const id = useId();

  return (
    <label className="messaging-field" htmlFor={id}>
      {label}
      <Input
        id={id}
        type={type}
        required={required}
        maxLength={maxLength}
        inputMode={inputMode}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function Choice<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: Record<Value, () => string>;
  onChange: (value: Value) => void;
}) {
  const id = useId();

  return (
    <div className="messaging-field">
      <span id={id}>{label}</span>
      <Select
        aria-labelledby={id}
        value={value}
        onValueChange={(next) => next && onChange(next)}
        options={(Object.keys(options) as Value[]).map((option) => ({
          value: option,
          label: options[option](),
        }))}
      />
    </div>
  );
}

/** Edits a fact's kind and value with fields that fit the kind. */
export function FactValueFields({
  value,
  onChange,
  kindEditable = true,
}: {
  value: FactValue;
  onChange: (value: FactValue) => void;
  kindEditable?: boolean;
}) {
  const kindId = useId();

  return (
    <div className="messaging-fact-fields">
      {kindEditable ? (
        <div className="messaging-field">
          <span id={kindId}>{m.messaging_fact_kind()}</span>
          <Select
            aria-labelledby={kindId}
            value={value.kind}
            onValueChange={(next) => next && onChange(emptyFact(next))}
            options={factKinds.map((kind) => ({
              value: kind,
              label: factKindLabels[kind](),
            }))}
          />
        </div>
      ) : null}
      <KindFields value={value} onChange={onChange} />
    </div>
  );
}

function KindFields({
  value,
  onChange,
}: {
  value: FactValue;
  onChange: (value: FactValue) => void;
}) {
  switch (value.kind) {
    case 'party':
      return (
        <>
          <Choice
            label={m.messaging_fact_role()}
            value={value.role}
            options={partyRoleLabels}
            onChange={(role) => onChange({ ...value, role })}
          />
          <Text
            label={m.messaging_fact_name()}
            required
            value={value.name}
            onChange={(name) => onChange({ ...value, name })}
          />
          <Text
            label={m.messaging_fact_email()}
            type="email"
            maxLength={320}
            value={value.email ?? ''}
            onChange={(email) => onChange({ ...value, email: orNull(email) })}
          />
        </>
      );
    case 'reference':
      return (
        <>
          <Choice
            label={m.messaging_fact_role()}
            value={value.role}
            options={referenceRoleLabels}
            onChange={(role) => onChange({ ...value, role })}
          />
          <Text
            label={m.messaging_fact_reference()}
            required
            value={value.text}
            onChange={(text) => onChange({ ...value, text })}
          />
        </>
      );
    case 'line':
      return (
        <>
          <Text
            label={m.messaging_fact_sku()}
            value={value.sku ?? ''}
            onChange={(sku) => onChange({ ...value, sku: orNull(sku) })}
          />
          <Text
            label={m.messaging_fact_description()}
            maxLength={500}
            value={value.description ?? ''}
            onChange={(description) =>
              onChange({ ...value, description: orNull(description) })
            }
          />
          <Text
            label={m.messaging_fact_quantity()}
            inputMode="decimal"
            value={value.quantity ?? ''}
            onChange={(quantity) =>
              onChange({ ...value, quantity: orNull(quantity) })
            }
          />
          <Text
            label={m.messaging_fact_unit()}
            maxLength={40}
            value={value.unit ?? ''}
            onChange={(unit) => onChange({ ...value, unit: orNull(unit) })}
          />
          <Text
            label={m.messaging_fact_unit_price()}
            inputMode="decimal"
            value={value.unitPrice?.amount ?? ''}
            onChange={(amount) =>
              onChange({
                ...value,
                unitPrice: amount.trim()
                  ? {
                      amount,
                      currency: value.unitPrice?.currency ?? 'EUR',
                    }
                  : null,
              })
            }
          />
          {value.unitPrice ? (
            <Text
              label={m.messaging_fact_currency()}
              maxLength={3}
              value={value.unitPrice.currency}
              onChange={(currency) =>
                onChange({
                  ...value,
                  unitPrice: {
                    amount: value.unitPrice?.amount ?? '',
                    currency: currency.toUpperCase(),
                  },
                })
              }
            />
          ) : null}
        </>
      );
    case 'date':
      return (
        <>
          <Choice
            label={m.messaging_fact_role()}
            value={value.role}
            options={dateRoleLabels}
            onChange={(role) => onChange({ ...value, role })}
          />
          <Text
            label={m.messaging_fact_date()}
            type="date"
            required
            value={value.date}
            onChange={(date) => onChange({ ...value, date })}
          />
        </>
      );
    case 'amount':
      return (
        <>
          <Choice
            label={m.messaging_fact_role()}
            value={value.role}
            options={amountRoleLabels}
            onChange={(role) => onChange({ ...value, role })}
          />
          <Text
            label={m.messaging_fact_amount()}
            inputMode="decimal"
            required
            value={value.money.amount}
            onChange={(amount) =>
              onChange({ ...value, money: { ...value.money, amount } })
            }
          />
          <Text
            label={m.messaging_fact_currency()}
            required
            maxLength={3}
            value={value.money.currency}
            onChange={(currency) =>
              onChange({
                ...value,
                money: { ...value.money, currency: currency.toUpperCase() },
              })
            }
          />
        </>
      );
  }
}

/**
 * Chooses which record a corrected fact refers to: one of the candidates Luma found, the current
 * match, or none.
 */
export function RecordChoice({
  options,
  value,
  onChange,
}: {
  options: readonly RecordRef[];
  value: string;
  onChange: (value: string) => void;
}) {
  if (!options.length) return null;

  return (
    <fieldset className="messaging-candidates">
      <legend>{m.messaging_fact_record_choice()}</legend>
      {options.map((record) => {
        const key = `${record.kind}:${record.id}`;

        return (
          <label key={key}>
            <input
              type="radio"
              name="record"
              value={key}
              checked={value === key}
              onChange={() => onChange(key)}
            />
            <span>{recordName(record)}</span>
          </label>
        );
      })}
      <label>
        <input
          type="radio"
          name="record"
          value=""
          checked={value === ''}
          onChange={() => onChange('')}
        />
        <span>{m.messaging_fact_record_none()}</span>
      </label>
    </fieldset>
  );
}
