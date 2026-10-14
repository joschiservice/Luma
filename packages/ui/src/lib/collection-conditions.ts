import {
  formatCalendarDate,
  formatCurrency,
  formatList,
  formatNumber,
} from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';

/*
 * Condition shapes for list filters. They mirror the list API's `where` parameter so a page can
 * pass its view state straight through; the UI package keeps its own copy because it does not
 * depend on the API contract at run time.
 */

type ConditionFieldType =
  | 'text'
  | 'enum'
  | 'tags'
  | 'number'
  | 'money'
  | 'date'
  | 'boolean'
  | 'person'
  | 'reference';

/**
 * `empty` means the source reported no value; `unknown` means Luma has not read the value or
 * cannot see it.
 */
export type ConditionOperator =
  | 'is'
  | 'is_not'
  | 'any_of'
  | 'none_of'
  | 'all_of'
  | 'contains'
  | 'not_contains'
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'before'
  | 'after'
  | 'within_last'
  | 'within_next'
  | 'empty'
  | 'not_empty'
  | 'unknown';

export type ConditionGranularity = 'day' | 'week' | 'month';

export type ConditionScalar = string | number | boolean;

/** Resolved for each reader when the list is read. */
export interface ConditionDynamic {
  dynamic: 'me' | 'today';
}

/** A period such as the last 7 days. */
export interface ConditionRelative {
  amount: number;
  unit: ConditionGranularity;
}

/** An amount as a decimal string in one ISO 4217 currency. */
export interface ConditionMoney {
  amount: string;
  currency: string;
}

type ConditionBound =
  ConditionScalar | ConditionMoney | ConditionDynamic | null;

/** An inclusive range; at least one bound is set. */
export interface ConditionRange {
  from: ConditionBound;
  to: ConditionBound;
}

export type ConditionValue =
  | ConditionScalar
  | ConditionDynamic
  | ConditionRelative
  | ConditionMoney
  | ConditionRange
  | (ConditionScalar | ConditionDynamic)[];

export interface Condition {
  field: string;
  op: ConditionOperator;
  value?: ConditionValue | undefined;
  /** `any`, `every` or `lowest` source, or one source's ID, for per-source fields. */
  source?: string | undefined;
}

export interface ConditionWhere {
  match: 'all' | 'any';
  conditions: Condition[];
}

export interface ConditionOption {
  value: string;
  label: string;
}

/** A field people can filter by, with the operators the list accepts for it. */
export interface ConditionField {
  id: string;
  label: string;
  type: ConditionFieldType;
  operators: readonly ConditionOperator[];
  /** Heading the field is listed under, such as "Fulfillment". */
  group?: string | undefined;
  options?: readonly ConditionOption[] | undefined;
  /** Person fields: offers "Me", which resolves to whoever reads the list. */
  offerMe?: boolean | undefined;
  /** Every source reports its own value; conditions may name a source. */
  perSource?: boolean | undefined;
  /** Connected sources a per-source condition can name. */
  sources?: readonly ConditionOption[] | undefined;
  /** Currencies offered for money amounts; the first is the default. */
  currencies?: readonly string[] | undefined;
  /** Listed but not selectable, with the reason, such as a missing permission. */
  unavailable?: string | undefined;
}

/** A problem the list reported for one condition, by its index in `conditions`. */
export interface ConditionIssue {
  index: number | null;
  message: string;
}

/** The editor a condition's value needs. */
export type ConditionValueKind =
  | 'none'
  | 'options'
  | 'option'
  | 'text'
  | 'number'
  | 'number-range'
  | 'money'
  | 'money-range'
  | 'date'
  | 'date-range'
  | 'relative'
  | 'boolean';

const valueless = new Set<ConditionOperator>(['empty', 'not_empty', 'unknown']);
const listOperators = new Set<ConditionOperator>([
  'any_of',
  'none_of',
  'all_of',
]);
const choiceTypes = new Set<ConditionFieldType>([
  'enum',
  'tags',
  'person',
  'reference',
]);

/** Which value editor an operator needs for a field. */
export function conditionValueKind(
  field: Pick<ConditionField, 'type' | 'options'>,
  op: ConditionOperator,
): ConditionValueKind {
  if (valueless.has(op)) return 'none';
  if (listOperators.has(op)) return 'options';
  if (field.type === 'boolean') return 'boolean';
  if (field.type === 'text') return field.options?.length ? 'option' : 'text';
  if (choiceTypes.has(field.type)) return 'option';
  if (field.type === 'number')
    return op === 'between' ? 'number-range' : 'number';
  if (field.type === 'money') return op === 'between' ? 'money-range' : 'money';
  if (op === 'between') return 'date-range';
  if (op === 'within_last' || op === 'within_next') return 'relative';

  return 'date';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a value is a reader-relative value such as "me" or "today". */
export function isDynamic(value: unknown): value is ConditionDynamic {
  return (
    isObject(value) && (value.dynamic === 'me' || value.dynamic === 'today')
  );
}

/** Whether a value is an amount in a currency. */
export function isMoney(value: unknown): value is ConditionMoney {
  return (
    isObject(value) &&
    typeof value.amount === 'string' &&
    typeof value.currency === 'string'
  );
}

/** Whether a value is a relative period. */
export function isRelative(value: unknown): value is ConditionRelative {
  return isObject(value) && typeof value.amount === 'number' && 'unit' in value;
}

/** Whether a value is a range with a start, an end or both. */
export function isRange(value: unknown): value is ConditionRange {
  return isObject(value) && 'from' in value && 'to' in value;
}

const decimal = /^-?\d{1,14}(\.\d{1,6})?$/;

/** Whether a range bound holds a value; a money bound needs an amount. */
function boundSet(
  bound: ConditionBound | undefined,
): bound is NonNullable<ConditionBound> {
  if (bound === null || bound === undefined || bound === '') return false;

  return !isMoney(bound) || bound.amount !== '';
}

/**
 * Whether a condition has the value its operator needs, so it can be applied. Mirrors the list
 * API's shape checks; the API still validates fields, options and permissions.
 */
export function conditionComplete(
  field: Pick<ConditionField, 'type' | 'options'>,
  condition: Condition,
): boolean {
  const { value } = condition;
  switch (conditionValueKind(field, condition.op)) {
    case 'none':
      return value === undefined;
    case 'options':
      return Array.isArray(value) && value.length > 0 && value.length <= 50;
    case 'option':
    case 'text':
      return typeof value === 'string' && value.trim() !== '';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'money':
      return isMoney(value) && decimal.test(value.amount);
    case 'date':
      return (
        (typeof value === 'string' && value !== '') ||
        (isDynamic(value) && value.dynamic === 'today')
      );
    case 'relative':
      return (
        isRelative(value) &&
        Number.isInteger(value.amount) &&
        value.amount >= 0 &&
        value.amount <= 3660
      );
    case 'number-range':
    case 'date-range':
    case 'money-range':
      return (
        isRange(value) &&
        (boundSet(value.from) || boundSet(value.to)) &&
        [value.from, value.to].every(
          (bound) =>
            !boundSet(bound) ||
            field.type !== 'money' ||
            (isMoney(bound) && decimal.test(bound.amount)),
        )
      );
  }
}

/**
 * The value an operator starts with: kept when the previous value still fits the new operator,
 * otherwise empty, with money in the field's first currency.
 */
export function conditionDefaultValue(
  field: Pick<ConditionField, 'type' | 'options' | 'currencies'>,
  op: ConditionOperator,
  previous?: Condition,
): ConditionValue | undefined {
  const kind = conditionValueKind(field, op);
  if (previous && conditionValueKind(field, previous.op) === kind)
    return previous.value;
  const currency = field.currencies?.[0] ?? '';
  switch (kind) {
    case 'none':
      return undefined;
    case 'options':
      return [];
    case 'boolean':
      return true;
    case 'relative':
      return { amount: 7, unit: 'day' };
    case 'money':
      return { amount: '', currency };
    case 'number-range':
    case 'date-range':
      return { from: null, to: null };
    case 'money-range':
      return {
        from: { amount: '', currency },
        to: { amount: '', currency },
      };
    default:
      return '';
  }
}

/** Starts a condition on a field with its first operator. */
export function newCondition(field: ConditionField): Condition {
  const op = field.operators[0] ?? 'is';

  return {
    field: field.id,
    op,
    value: conditionDefaultValue(field, op),
    ...(field.perSource ? { source: 'any' } : {}),
  };
}

/**
 * Prepares an edited condition for the list API: drops empty range bounds and blank money
 * amounts, and omits a value for operators that take none.
 */
export function finishCondition(
  field: Pick<ConditionField, 'type' | 'options' | 'perSource'>,
  condition: Condition,
): Condition {
  const kind = conditionValueKind(field, condition.op);
  const base = { field: condition.field, op: condition.op };
  const scoped =
    field.perSource && condition.source ? { source: condition.source } : {};
  if (kind === 'none') return { ...base, ...scoped };
  let value = condition.value;
  if (isRange(value)) {
    const clean = (bound: ConditionBound) => (boundSet(bound) ? bound : null);
    value = { from: clean(value.from), to: clean(value.to) };
  }
  if (typeof value === 'string' && kind === 'text') value = value.trim();

  return { ...base, value, ...scoped };
}

/** The operator's label, such as "is any of" or "is in the last". */
export function operatorLabel(op: ConditionOperator): string {
  const labels: Record<ConditionOperator, () => string> = {
    is: m.ui_condition_op_is,
    is_not: m.ui_condition_op_is_not,
    any_of: m.ui_condition_op_any_of,
    none_of: m.ui_condition_op_none_of,
    all_of: m.ui_condition_op_all_of,
    contains: m.ui_condition_op_contains,
    not_contains: m.ui_condition_op_not_contains,
    eq: m.ui_condition_op_eq,
    ne: m.ui_condition_op_ne,
    gt: m.ui_condition_op_gt,
    gte: m.ui_condition_op_gte,
    lt: m.ui_condition_op_lt,
    lte: m.ui_condition_op_lte,
    between: m.ui_condition_op_between,
    before: m.ui_condition_op_before,
    after: m.ui_condition_op_after,
    within_last: m.ui_condition_op_within_last,
    within_next: m.ui_condition_op_within_next,
    empty: m.ui_condition_op_empty,
    not_empty: m.ui_condition_op_not_empty,
    unknown: m.ui_condition_op_unknown,
  };

  return labels[op]();
}

/** A period length such as "7 days". */
function relativeLabel(value: ConditionRelative): string {
  const count = value.amount;
  if (value.unit === 'week') return m.ui_condition_weeks({ count });
  if (value.unit === 'month') return m.ui_condition_months({ count });

  return m.ui_condition_days({ count });
}

/** The label of a per-source scope: any, every or lowest source, or one named source. */
export function sourceScopeLabel(
  source: string,
  sources: readonly ConditionOption[] = [],
): string {
  if (source === 'any') return m.ui_condition_source_any();
  if (source === 'every') return m.ui_condition_source_every();
  if (source === 'lowest') return m.ui_condition_source_lowest();

  return sources.find((option) => option.value === source)?.label ?? source;
}

/**
 * What "me" and "today" mean for the reader, so chips can show the resolved person and dates
 * next to the dynamic value a saved view keeps. `today` is the workspace day as YYYY-MM-DD.
 */
export interface ConditionResolution {
  me?: string | undefined;
  today?: string | undefined;
}

/** Adds whole days, weeks or months to a calendar day, staying on calendar days. */
function shiftDay(
  day: string,
  amount: number,
  unit: ConditionRelative['unit'],
) {
  const date = new Date(`${day}T00:00:00Z`);
  if (unit === 'month') date.setUTCMonth(date.getUTCMonth() + amount);
  else date.setUTCDate(date.getUTCDate() + amount * (unit === 'week' ? 7 : 1));

  return date.toISOString().slice(0, 10);
}

function scalarLabel(
  field: Pick<ConditionField, 'type' | 'options'>,
  value: ConditionScalar | ConditionDynamic | ConditionMoney,
  resolution: ConditionResolution = {},
): string {
  if (isDynamic(value))
    return value.dynamic === 'me'
      ? resolution.me
        ? m.ui_condition_resolved({
            value: m.ui_condition_me(),
            resolved: resolution.me,
          })
        : m.ui_condition_me()
      : resolution.today
        ? m.ui_condition_resolved({
            value: m.ui_condition_today(),
            resolved: formatCalendarDate(resolution.today),
          })
        : m.ui_condition_today();
  if (isMoney(value)) {
    const amount = Number(value.amount);

    return Number.isFinite(amount) && /^[A-Z]{3}$/.test(value.currency)
      ? formatCurrency(amount, value.currency)
      : `${value.amount} ${value.currency}`.trim();
  }
  if (typeof value === 'boolean') return value ? m.common_yes() : m.common_no();
  if (typeof value === 'number') return formatNumber(value);
  const option = field.options?.find((item) => item.value === value);
  if (option) return option.label;
  if (field.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value))
    return formatCalendarDate(value);
  if (field.type === 'text') return m.ui_condition_text_value({ value });

  return value;
}

/** How many values a chip names before summarizing the rest as a count. */
const namedValues = 2;

/** The condition's value as shown on a chip, or an empty string for operators without one. */
export function conditionValueLabel(
  field: Pick<ConditionField, 'type' | 'options'>,
  condition: Condition,
  resolution: ConditionResolution = {},
): string {
  const { value } = condition;
  if (value === undefined) return '';
  if (Array.isArray(value)) {
    const labels = value.map((item) => scalarLabel(field, item, resolution));
    const type = condition.op === 'all_of' ? 'conjunction' : 'disjunction';
    if (labels.length <= namedValues + 1) return formatList(labels, { type });

    return m.ui_condition_values_more({
      values: formatList(labels.slice(0, namedValues), { type: 'unit' }),
      count: labels.length - namedValues,
    });
  }
  if (isRelative(value)) {
    const period = relativeLabel(value);
    if (!resolution.today) return period;
    const [from, to] =
      condition.op === 'within_next'
        ? [
            resolution.today,
            shiftDay(resolution.today, value.amount, value.unit),
          ]
        : [
            shiftDay(resolution.today, -value.amount, value.unit),
            resolution.today,
          ];

    return m.ui_condition_resolved({
      value: period,
      resolved: m.ui_condition_range({
        from: formatCalendarDate(from),
        to: formatCalendarDate(to),
      }),
    });
  }
  if (isRange(value)) {
    const from = boundSet(value.from)
      ? scalarLabel(field, value.from, resolution)
      : undefined;
    const to = boundSet(value.to)
      ? scalarLabel(field, value.to, resolution)
      : undefined;
    if (from && to) return m.ui_condition_range({ from, to });
    if (from) return m.ui_condition_range_from({ from });

    return to ? m.ui_condition_range_to({ to }) : '';
  }

  return scalarLabel(field, value, resolution);
}

/** The whole condition as one sentence fragment, such as "Status is any of Open or Paid". */
export function describeCondition(
  field: Pick<ConditionField, 'type' | 'options' | 'label' | 'sources'>,
  condition: Condition,
  resolution: ConditionResolution = {},
): string {
  const value = conditionValueLabel(field, condition, resolution);
  const subject = condition.source
    ? m.ui_condition_field_source({
        field: field.label,
        source: sourceScopeLabel(condition.source, field.sources),
      })
    : field.label;
  const operator = operatorLabel(condition.op);

  return value
    ? m.ui_condition_summary({ field: subject, operator, value })
    : m.ui_condition_summary_valueless({ field: subject, operator });
}

/** Scalar values a table cell can offer to filter by. */
export type CellFilterValue = string | number | boolean | ConditionMoney | null;

function sameScalar(a: unknown, b: unknown) {
  if (isMoney(a) && isMoney(b))
    return a.amount === b.amount && a.currency === b.currency;

  return a === b;
}

/**
 * The condition that keeps (or, with `exclude`, removes) rows whose field equals a cell's value,
 * or undefined when the field offers no fitting operator. A missing value matches `empty`.
 */
function cellCondition(
  field: Pick<ConditionField, 'id' | 'type' | 'operators'>,
  value: CellFilterValue,
  exclude = false,
): Condition | undefined {
  const offered = (op: ConditionOperator) => field.operators.includes(op);
  const make = (op: ConditionOperator, next?: ConditionValue) =>
    offered(op)
      ? { field: field.id, op, ...(next === undefined ? {} : { value: next }) }
      : undefined;
  if (value === null || value === '')
    return make(exclude ? 'not_empty' : 'empty');
  if (field.type === 'boolean')
    return typeof value === 'boolean'
      ? make('is', exclude ? !value : value)
      : undefined;
  if (choiceTypes.has(field.type) && typeof value !== 'object')
    return make(exclude ? 'none_of' : 'any_of', [value]);
  if (field.type === 'text' && typeof value === 'string')
    return make(exclude ? 'is_not' : 'is', value);
  if (field.type === 'number' && typeof value === 'number')
    return make(exclude ? 'ne' : 'eq', value);
  if (field.type === 'money' && isMoney(value))
    return make(exclude ? 'ne' : 'eq', value);
  if (field.type === 'date' && typeof value === 'string' && !exclude)
    return make('between', { from: value, to: value });

  return undefined;
}

/**
 * Adds a cell's condition to `where`. Excluding merges into the field's existing exclusion list;
 * filtering to a value replaces the field's existing inclusion. Returns undefined when the field
 * cannot express it, so a table can hide the action.
 */
export function whereWithCellValue(
  where: ConditionWhere,
  field: Pick<ConditionField, 'id' | 'type' | 'operators'>,
  value: CellFilterValue,
  exclude = false,
): ConditionWhere | undefined {
  const condition = cellCondition(field, value, exclude);
  if (!condition) return undefined;
  const existing = where.conditions.findIndex(
    (item) =>
      item.field === field.id && item.op === condition.op && !item.source,
  );
  const conditions = [...where.conditions];
  if (existing < 0) conditions.push(condition);
  else {
    const current = conditions[existing]!;
    if (
      condition.op === 'none_of' &&
      Array.isArray(current.value) &&
      Array.isArray(condition.value)
    ) {
      const merged = [...current.value];
      for (const item of condition.value)
        if (!merged.some((other) => sameScalar(other, item))) merged.push(item);
      conditions[existing] = { ...current, value: merged };
    } else conditions[existing] = condition;
  }

  return { ...where, conditions };
}
