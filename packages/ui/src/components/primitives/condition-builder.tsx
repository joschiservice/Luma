import { m } from '@luma/i18n/messages';
import { AlertTriangle, Check, ChevronLeft, Plus, X } from 'lucide-react';
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useId,
  useState,
} from 'react';

import {
  type Condition,
  conditionComplete,
  conditionDefaultValue,
  type ConditionDynamic,
  type ConditionField,
  type ConditionGranularity,
  type ConditionIssue,
  type ConditionMoney,
  type ConditionOperator,
  type ConditionResolution,
  type ConditionScalar,
  conditionValueKind,
  conditionValueLabel,
  type ConditionWhere,
  describeCondition,
  finishCondition,
  isDynamic,
  isMoney,
  isRange,
  isRelative,
  newCondition,
  operatorLabel,
  sourceScopeLabel,
} from '../../lib/collection-conditions';
import { Button } from './button';
import { FocusFirst } from './collection-filters';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { Input } from './input';
import { ResponsivePopover } from './responsive-popover';
import { Select, type SelectProps } from './select';

export type * from '../../lib/collection-conditions';

/** Long option lists get a field that narrows them. */
const searchableOptions = 8;

/** Advanced filter conditions for a collection; the caller owns `where` and fetching. */
export interface CollectionConditions {
  fields: readonly ConditionField[];
  where: ConditionWhere;
  onWhereChange: (where: ConditionWhere) => void;
  /** Problems the list reported, shown on the matching chips. */
  issues?: readonly ConditionIssue[] | undefined;
  /** Whether the field picker is open; pass it to open the picker from the F key. */
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  /**
   * The field the builder opens at, skipping the field list, such as the column whose menu
   * chose "Filter by this column". "Choose another field" still returns to the list.
   */
  field?: string | undefined;
  /** Shows who "me" is and which days relative periods cover for this reader. */
  resolution?: ConditionResolution | undefined;
}

/**
 * Lists a collection's conditions as chips and adds new ones from "+ Filter": pick a field, then
 * an operator and a value suited to the field's type. Chips open the same editor and can be
 * removed; with two or more conditions a toggle chooses whether all or any must match. A
 * condition the list rejected shows its message and stays editable. Every change is reported
 * through `onWhereChange`.
 */
export function ConditionFilters({
  fields,
  where,
  onWhereChange,
  issues = [],
  open,
  onOpenChange,
  field,
  resolution,
}: CollectionConditions) {
  const [editing, setEditing] = useState<number | null>(null);
  const byId = new Map(fields.map((field) => [field.id, field]));
  const replace = (index: number, condition: Condition | undefined) =>
    onWhereChange({
      ...where,
      conditions: where.conditions.flatMap((item, position) =>
        position !== index ? [item] : condition ? [condition] : [],
      ),
    });

  return (
    <>
      {where.conditions.length > 1 ? (
        <MatchToggle
          match={where.match}
          onChange={(match) => onWhereChange({ ...where, match })}
        />
      ) : null}
      {where.conditions.map((condition, index) => (
        <ConditionChip
          key={`${condition.field}-${index}`}
          field={byId.get(condition.field)}
          condition={condition}
          issue={issues.find((issue) => issue.index === index)?.message}
          resolution={resolution}
          open={editing === index}
          onOpenChange={(next) => setEditing(next ? index : null)}
          onChange={(next) => {
            replace(index, next);
            setEditing(null);
          }}
          onRemove={() => replace(index, undefined)}
        />
      ))}
      <AddCondition
        fields={fields}
        open={open}
        onOpenChange={onOpenChange}
        preset={field}
        onAdd={(condition) =>
          onWhereChange({
            ...where,
            conditions: [...where.conditions, condition],
          })
        }
      />
    </>
  );
}

function MatchToggle({
  match,
  onChange,
}: {
  match: ConditionWhere['match'];
  onChange: (match: ConditionWhere['match']) => void;
}) {
  const label =
    match === 'all' ? m.ui_condition_match_all() : m.ui_condition_match_any();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" className="collection-condition-match" />
        }
      >
        {label}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{m.ui_condition_match_label()}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={match}
            onValueChange={(value: ConditionWhere['match']) => onChange(value)}
          >
            <DropdownMenuRadioItem value="all" closeOnClick>
              {m.ui_condition_match_all()}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="any" closeOnClick>
              {m.ui_condition_match_any()}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ConditionChip({
  field,
  condition,
  issue,
  resolution,
  open,
  onOpenChange,
  onChange,
  onRemove,
}: {
  field: ConditionField | undefined;
  condition: Condition;
  issue: string | undefined;
  resolution?: ConditionResolution | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (condition: Condition) => void;
  onRemove: () => void;
}) {
  const known = field ?? {
    id: condition.field,
    label: condition.field,
    type: 'text' as const,
    operators: [],
  };
  const summary = describeCondition(known, condition, resolution);
  const value = conditionValueLabel(known, condition, resolution);
  const content = (
    <>
      {issue ? <AlertTriangle aria-hidden="true" /> : null}
      <span className="collection-filter-label">
        {condition.source
          ? m.ui_condition_field_source({
              field: known.label,
              source: sourceScopeLabel(condition.source, known.sources),
            })
          : known.label}
      </span>
      <span className="collection-condition-operator">
        {operatorLabel(condition.op)}
      </span>
      {value ? (
        <span className="collection-condition-value">{value}</span>
      ) : null}
    </>
  );
  const name = issue
    ? m.ui_condition_invalid({ condition: summary, message: issue })
    : m.ui_condition_edit({ condition: summary });

  return (
    <div
      className="collection-filter-chip collection-condition-chip"
      data-invalid={issue ? '' : undefined}
    >
      {field && !field.unavailable ? (
        <ResponsivePopover
          title={field.label}
          open={open}
          onOpenChange={onOpenChange}
          trigger={
            <Button variant="ghost" aria-label={name} title={issue}>
              {content}
            </Button>
          }
        >
          <FocusFirst>
            <ConditionEditor
              field={field}
              condition={condition}
              issue={issue}
              onApply={onChange}
            />
          </FocusFirst>
        </ResponsivePopover>
      ) : (
        <span
          className="collection-filter-static"
          title={issue ?? field?.unavailable}
        >
          {content}
          <span className="sr-only">{issue ?? field?.unavailable}</span>
        </span>
      )}
      <Button
        variant="ghost"
        size="icon"
        aria-label={m.ui_condition_remove({ condition: summary })}
        onClick={onRemove}
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}

function AddCondition({
  fields,
  open: controlled,
  onOpenChange,
  preset,
  onAdd,
}: {
  fields: readonly ConditionField[];
  open: boolean | undefined;
  onOpenChange: ((open: boolean) => void) | undefined;
  preset: string | undefined;
  onAdd: (condition: Condition) => void;
}) {
  const [uncontrolled, setUncontrolled] = useState(false);
  // Undefined until the reader picks or returns to the list; the preset field applies until then.
  const [choice, setChoice] = useState<{
    field?: ConditionField | undefined;
  }>();
  const open = controlled ?? uncontrolled;
  const presetField = fields.find(
    (item) => item.id === preset && !item.unavailable,
  );
  const picked = choice ? choice.field : presetField;
  const setPicked = (field?: ConditionField) => setChoice({ field });
  const setOpen = (next: boolean) => {
    if (!next) setChoice(undefined);
    setUncontrolled(next);
    onOpenChange?.(next);
  };
  if (!fields.length) return null;

  return (
    <div className="collection-condition-add">
      <ResponsivePopover
        title={picked?.label ?? m.ui_condition_add_label()}
        open={open}
        onOpenChange={setOpen}
        trigger={
          <Button variant="ghost" aria-label={m.ui_condition_add_label()}>
            <Plus aria-hidden="true" />
            {m.ui_condition_add()}
          </Button>
        }
      >
        {picked ? (
          <FocusFirst key={picked.id}>
            <ConditionEditor
              field={picked}
              condition={newCondition(picked)}
              onApply={(condition) => {
                onAdd(condition);
                setOpen(false);
              }}
              onBack={() => setPicked()}
            />
          </FocusFirst>
        ) : (
          <FocusFirst>
            <FieldPicker fields={fields} onPick={setPicked} />
          </FocusFirst>
        )}
      </ResponsivePopover>
    </div>
  );
}

/** Moves focus between the picker's search field and its options with the arrow keys. */
function arrowNavigation(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(
      'input, button:not(:disabled)',
    ),
  ];
  const index = items.findIndex((item) => item === document.activeElement);
  const next = items[index + (event.key === 'ArrowDown' ? 1 : -1)];
  if (!next) return;
  event.preventDefault();
  next.focus();
}

/**
 * Chooses the field for a new condition from a searchable list grouped by area. Unavailable
 * fields stay listed, disabled, with their reason.
 */
function FieldPicker({
  fields,
  onPick,
}: {
  fields: readonly ConditionField[];
  onPick: (field: ConditionField) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const term = query.trim().toLowerCase();
  const matches = fields.filter((field) =>
    field.label.toLowerCase().includes(term),
  );
  const groups = new Map<string, ConditionField[]>();
  for (const field of matches) {
    const group = field.group ?? '';
    groups.set(group, [...(groups.get(group) ?? []), field]);
  }

  return (
    <div className="collection-condition-fields" onKeyDown={arrowNavigation}>
      <Input
        type="search"
        aria-label={m.ui_condition_field_search_label()}
        placeholder={m.ui_condition_field_search_placeholder()}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          const first = matches.find((field) => !field.unavailable);
          if (event.key !== 'Enter' || !first) return;
          event.preventDefault();
          onPick(first);
        }}
      />
      {[...groups].map(([group, items], index) => (
        <div
          key={group}
          role="group"
          className="collection-condition-field-group"
          aria-labelledby={group ? `${id}-${index}` : undefined}
          aria-label={group ? undefined : m.ui_condition_other_fields()}
        >
          {group ? (
            <p id={`${id}-${index}`} className="collection-condition-heading">
              {group}
            </p>
          ) : null}
          {items.map((field) => (
            <Button
              key={field.id}
              variant="ghost"
              className="collection-condition-field"
              disabled={!!field.unavailable}
              aria-describedby={
                field.unavailable ? `${id}-${field.id}-reason` : undefined
              }
              onClick={() => onPick(field)}
            >
              <span className="truncate">{field.label}</span>
              {field.unavailable ? (
                <span
                  id={`${id}-${field.id}-reason`}
                  className="collection-condition-reason"
                >
                  {field.unavailable}
                </span>
              ) : null}
            </Button>
          ))}
        </div>
      ))}
      {!matches.length ? (
        <p className="collection-filter-none">{m.ui_condition_no_fields()}</p>
      ) : null}
    </div>
  );
}

/**
 * Edits one condition: the operator, the source for per-source fields and a value editor suited
 * to the field type and operator. Applying reports a cleaned condition; an incomplete value shows
 * what is missing instead.
 */
function ConditionEditor({
  field,
  condition,
  issue,
  onApply,
  onBack,
}: {
  field: ConditionField;
  condition: Condition;
  /** A problem the list reported for this condition. */
  issue?: string | undefined;
  onApply: (condition: Condition) => void;
  /** Returns to the field list when adding a condition. */
  onBack?: (() => void) | undefined;
}) {
  const id = useId();
  const [draft, setDraft] = useState(condition);
  const [incomplete, setIncomplete] = useState(false);
  const kind = conditionValueKind(field, draft.op);
  const setValue = (value: Condition['value']) => {
    setIncomplete(false);
    setDraft((current) => ({ ...current, value }));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const finished = finishCondition(field, draft);
    if (!conditionComplete(field, finished)) return setIncomplete(true);
    onApply(finished);
  };
  const sourceOptions = [
    { value: 'any', label: sourceScopeLabel('any') },
    { value: 'every', label: sourceScopeLabel('every') },
    ...(field.type === 'number'
      ? [{ value: 'lowest', label: sourceScopeLabel('lowest') }]
      : []),
    ...(field.sources ?? []),
  ];

  return (
    <form className="collection-condition-editor" noValidate onSubmit={submit}>
      {onBack ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="collection-condition-back"
          onClick={onBack}
        >
          <ChevronLeft aria-hidden="true" />
          {m.ui_condition_change_field()}
        </Button>
      ) : null}
      {issue ? (
        <p className="collection-condition-issue">
          <AlertTriangle aria-hidden="true" />
          <span>
            <strong>{m.ui_condition_invalid_title()}</strong> {issue}
          </span>
        </p>
      ) : null}
      {field.operators.length > 1 ? (
        <SelectField
          label={m.ui_condition_operator()}
          options={field.operators.map((op) => ({
            value: op,
            label: operatorLabel(op),
          }))}
          value={draft.op}
          onValueChange={(op: ConditionOperator | null) => {
            if (!op) return;
            setIncomplete(false);
            setDraft((current) => ({
              ...current,
              op,
              value: conditionDefaultValue(field, op, current),
            }));
          }}
        />
      ) : null}
      {field.perSource ? (
        <SelectField
          label={m.ui_condition_source_label()}
          options={sourceOptions}
          value={draft.source ?? 'any'}
          onValueChange={(source: string | null) =>
            source && setDraft((current) => ({ ...current, source }))
          }
        />
      ) : null}
      <ValueEditor
        id={`${id}-value`}
        field={field}
        kind={kind}
        value={draft.value}
        onChange={setValue}
      />
      {incomplete ? (
        <p className="collection-filter-error" role="alert">
          {m.ui_condition_needs_value()}
        </p>
      ) : null}
      <Button type="submit" size="sm" className="collection-condition-apply">
        {m.ui_condition_apply()}
      </Button>
    </form>
  );
}

function EditorField({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: ReactNode;
}) {
  return (
    <div className="collection-condition-control">
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}

/** A select named by its visible label. */
function SelectField<Value extends string>({
  label,
  ...props
}: Omit<SelectProps<Value>, 'aria-label' | 'aria-labelledby'> & {
  label: string;
}) {
  const id = useId();

  return (
    <div className="collection-condition-control">
      <span id={id} className="collection-condition-label">
        {label}
      </span>
      <Select aria-labelledby={id} {...props} />
    </div>
  );
}

type ListValue = (ConditionScalar | ConditionDynamic)[];

function listValue(value: Condition['value']): ListValue {
  return Array.isArray(value) ? value : [];
}

const me: ConditionDynamic = { dynamic: 'me' };

function ValueEditor({
  id,
  field,
  kind,
  value,
  onChange,
}: {
  id: string;
  field: ConditionField;
  kind: ReturnType<typeof conditionValueKind>;
  value: Condition['value'];
  onChange: (value: Condition['value']) => void;
}) {
  const currency = field.currencies?.[0] ?? '';
  switch (kind) {
    case 'none':
      return null;
    case 'options':
    case 'option':
      return (
        <OptionsEditor
          field={field}
          multiple={kind === 'options'}
          value={value}
          onChange={onChange}
        />
      );
    case 'boolean':
      return (
        <div
          className="collection-filter-options"
          role="group"
          aria-label={m.ui_condition_options_label({ field: field.label })}
        >
          {[true, false].map((option) => (
            <ToggleOption
              key={String(option)}
              label={option ? m.common_yes() : m.common_no()}
              active={value === option}
              onClick={() => onChange(option)}
            />
          ))}
        </div>
      );
    case 'text':
      return (
        <EditorField label={m.ui_condition_value()} id={id}>
          <Input
            id={id}
            maxLength={500}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => onChange(event.target.value)}
          />
        </EditorField>
      );
    case 'number':
      return (
        <EditorField label={m.ui_condition_value()} id={id}>
          <NumberInput
            id={id}
            value={typeof value === 'number' ? value : null}
            onChange={(next) => onChange(next ?? '')}
          />
        </EditorField>
      );
    case 'number-range': {
      const range = isRange(value) ? value : { from: null, to: null };
      const bound = (key: 'from' | 'to') =>
        typeof range[key] === 'number' ? range[key] : null;

      return (
        <div className="collection-condition-pair">
          <EditorField label={m.ui_condition_min()} id={`${id}-from`}>
            <NumberInput
              id={`${id}-from`}
              value={bound('from')}
              onChange={(from) => onChange({ ...range, from })}
            />
          </EditorField>
          <EditorField label={m.ui_condition_max()} id={`${id}-to`}>
            <NumberInput
              id={`${id}-to`}
              value={bound('to')}
              onChange={(to) => onChange({ ...range, to })}
            />
          </EditorField>
        </div>
      );
    }
    case 'money': {
      const money = isMoney(value) ? value : { amount: '', currency };

      return (
        <MoneyInput
          id={id}
          label={m.ui_condition_amount()}
          currencies={field.currencies ?? []}
          value={money}
          onChange={onChange}
        />
      );
    }
    case 'money-range': {
      const range = isRange(value) ? value : { from: null, to: null };
      const from = isMoney(range.from) ? range.from : { amount: '', currency };
      const to = isMoney(range.to) ? range.to : { amount: '', currency };
      const setCurrency = (next: string) =>
        onChange({
          from: { ...from, currency: next },
          to: { ...to, currency: next },
        });

      return (
        <div className="collection-condition-money-range">
          <div className="collection-condition-pair">
            <EditorField label={m.ui_condition_min()} id={`${id}-from`}>
              <AmountInput
                id={`${id}-from`}
                value={from.amount}
                onChange={(amount) =>
                  onChange({ from: { ...from, amount }, to })
                }
              />
            </EditorField>
            <EditorField label={m.ui_condition_max()} id={`${id}-to`}>
              <AmountInput
                id={`${id}-to`}
                value={to.amount}
                onChange={(amount) => onChange({ from, to: { ...to, amount } })}
              />
            </EditorField>
          </div>
          <CurrencyField
            currencies={field.currencies ?? []}
            value={from.currency}
            onChange={setCurrency}
          />
        </div>
      );
    }
    case 'date': {
      const today = isDynamic(value) && value.dynamic === 'today';

      return (
        <div className="collection-condition-date">
          <div
            className="collection-filter-options"
            role="group"
            aria-label={m.ui_condition_value()}
          >
            <ToggleOption
              label={m.ui_condition_today_option()}
              active={today}
              onClick={() => onChange({ dynamic: 'today' })}
            />
          </div>
          <EditorField label={m.ui_condition_specific_date()} id={id}>
            <Input
              id={id}
              type="date"
              value={typeof value === 'string' ? value : ''}
              onChange={(event) => onChange(event.target.value)}
            />
          </EditorField>
        </div>
      );
    }
    case 'date-range': {
      const range = isRange(value) ? value : { from: null, to: null };
      const bound = (key: 'from' | 'to') =>
        typeof range[key] === 'string' ? range[key] : '';

      return (
        <div className="collection-condition-pair">
          <EditorField label={m.ui_filter_range_from()} id={`${id}-from`}>
            <Input
              id={`${id}-from`}
              type="date"
              value={bound('from')}
              max={bound('to') || undefined}
              onChange={(event) =>
                onChange({ ...range, from: event.target.value || null })
              }
            />
          </EditorField>
          <EditorField label={m.ui_filter_range_through()} id={`${id}-to`}>
            <Input
              id={`${id}-to`}
              type="date"
              value={bound('to')}
              min={bound('from') || undefined}
              onChange={(event) =>
                onChange({ ...range, to: event.target.value || null })
              }
            />
          </EditorField>
        </div>
      );
    }
    case 'relative': {
      const period = isRelative(value)
        ? value
        : { amount: 7, unit: 'day' as const };
      const units: { value: ConditionGranularity; label: string }[] = [
        { value: 'day', label: m.ui_condition_unit_day() },
        { value: 'week', label: m.ui_condition_unit_week() },
        { value: 'month', label: m.ui_condition_unit_month() },
      ];

      return (
        <div className="collection-condition-pair">
          <EditorField
            label={m.ui_condition_relative_amount()}
            id={`${id}-amount`}
          >
            <NumberInput
              id={`${id}-amount`}
              min={0}
              max={3660}
              step={1}
              value={period.amount}
              onChange={(amount) =>
                onChange({ ...period, amount: amount ?? Number.NaN })
              }
            />
          </EditorField>
          <SelectField
            label={m.ui_condition_relative_unit()}
            options={units}
            value={period.unit}
            onValueChange={(unit: ConditionGranularity | null) =>
              unit && onChange({ ...period, unit })
            }
          />
        </div>
      );
    }
  }
}

/** A number field that keeps partial input such as "1." while typing. */
function NumberInput({
  id,
  value,
  onChange,
  min,
  max,
  step = 'any',
}: {
  id: string;
  value: number | null;
  onChange: (value: number | null) => void;
  min?: number | undefined;
  max?: number | undefined;
  step?: number | 'any';
}) {
  const [text, setText] = useState(value === null ? '' : String(value));

  return (
    <Input
      id={id}
      type="number"
      inputMode="decimal"
      min={min}
      max={max}
      step={step}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        const next = event.target.valueAsNumber;
        onChange(event.target.value === '' || Number.isNaN(next) ? null : next);
      }}
    />
  );
}

function AmountInput({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Input
      id={id}
      inputMode="decimal"
      autoComplete="off"
      value={value}
      onChange={(event) =>
        onChange(event.target.value.replace(',', '.').trim())
      }
    />
  );
}

function CurrencyField({
  currencies,
  value,
  onChange,
}: {
  currencies: readonly string[];
  value: string;
  onChange: (currency: string) => void;
}) {
  if (currencies.length < 2) return null;

  return (
    <SelectField
      label={m.ui_condition_currency()}
      options={currencies.map((currency) => ({
        value: currency,
        label: currency,
      }))}
      value={value}
      onValueChange={(currency: string | null) =>
        currency && onChange(currency)
      }
    />
  );
}

function MoneyInput({
  id,
  label,
  currencies,
  value,
  onChange,
}: {
  id: string;
  label: string;
  currencies: readonly string[];
  value: ConditionMoney;
  onChange: (value: ConditionMoney) => void;
}) {
  const single = currencies.length < 2 ? value.currency : undefined;

  return (
    <div className="collection-condition-pair">
      <EditorField
        label={single ? m.ui_condition_amount_in({ currency: single }) : label}
        id={`${id}-amount`}
      >
        <AmountInput
          id={`${id}-amount`}
          value={value.amount}
          onChange={(amount) => onChange({ ...value, amount })}
        />
      </EditorField>
      <CurrencyField
        currencies={currencies}
        value={value.currency}
        onChange={(currency) => onChange({ ...value, currency })}
      />
    </div>
  );
}

function OptionsEditor({
  field,
  multiple,
  value,
  onChange,
}: {
  field: ConditionField;
  multiple: boolean;
  value: Condition['value'];
  onChange: (value: Condition['value']) => void;
}) {
  const [query, setQuery] = useState('');
  const term = query.trim().toLowerCase();
  const options = (field.options ?? []).filter((option) =>
    option.label.toLowerCase().includes(term),
  );
  const chosen = multiple
    ? listValue(value)
    : value === undefined || value === ''
      ? []
      : [value];
  const has = (item: ConditionScalar | ConditionDynamic) =>
    chosen.some((other) =>
      isDynamic(item)
        ? isDynamic(other) && other.dynamic === item.dynamic
        : other === item,
    );
  const toggle = (item: ConditionScalar | ConditionDynamic) => {
    if (!multiple) return onChange(isDynamic(item) ? item : String(item));
    const list = listValue(value);
    onChange(
      has(item)
        ? list.filter((other) =>
            isDynamic(item)
              ? !(isDynamic(other) && other.dynamic === item.dynamic)
              : other !== item,
          )
        : [...list, item],
    );
  };
  const offerMe = field.offerMe && field.type === 'person' && !term;

  return (
    <div
      className="collection-filter-options"
      role="group"
      aria-label={m.ui_condition_options_label({ field: field.label })}
    >
      {(field.options?.length ?? 0) > searchableOptions ? (
        <Input
          type="search"
          aria-label={m.ui_filter_find_label()}
          placeholder={m.ui_filter_find_placeholder()}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      ) : null}
      {offerMe ? (
        <ToggleOption
          label={m.ui_condition_me()}
          active={has(me)}
          onClick={() => toggle(me)}
        />
      ) : null}
      {options.map((option) => (
        <ToggleOption
          key={option.value}
          label={option.label}
          active={has(option.value)}
          onClick={() => toggle(option.value)}
        />
      ))}
      {!options.length && !offerMe ? (
        <p className="collection-filter-none">{m.ui_select_no_matches()}</p>
      ) : null}
    </div>
  );
}

function ToggleOption({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      aria-pressed={active}
      className="collection-condition-option"
      onClick={onClick}
    >
      <span className="truncate">{label}</span>
      {active ? <Check aria-hidden="true" /> : null}
    </Button>
  );
}
