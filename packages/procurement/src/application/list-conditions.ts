import {
  type Amount,
  compareDecimals,
  type Decimal,
  parseDecimal,
} from '../domain/order-value.js';
import {
  formatLocalDate,
  type LocalDate,
  localDate,
  parseInstant,
  parseLocalDate,
  shiftLocalDate,
  startOfLocalDay,
} from './list-dates.js';
import type {
  ListCondition,
  ListOperator,
  ListRangeBound,
  ListRelativeValue,
  ListValue,
  ListWhere,
  StoredBound,
  StoredComparison,
  StoredCondition,
  StoredWhere,
} from './lists.js';

/** A value Luma cannot know, distinct from a value the record does not have (null). */
export const unknownValue: unique symbol = Symbol('unknown');

export type UnknownValue = typeof unknownValue;

/**
 * How one list field filters. `read` evaluates the field in memory; `stored` names the
 * operators the store applies in SQL instead. `ids` marks references to Luma records, whose
 * values must be UUIDs and compare ignoring case.
 */
export type ListField<T> = {
  operators: readonly ListOperator[];
  stored?: readonly ListOperator[];
  ids?: true;
} & (
  | { kind: 'text'; read?: (row: T) => string | null }
  | { kind: 'texts'; read?: (row: T) => readonly string[] }
  | { kind: 'choice'; read?: (row: T) => string | null }
  | { kind: 'choices'; read?: (row: T) => readonly string[] }
  | { kind: 'number'; read?: (row: T) => number | null }
  | { kind: 'money'; read?: (row: T) => Amount | null | UnknownValue }
  | { kind: 'instant'; read?: (row: T) => string | null }
  | { kind: 'day'; read?: (row: T) => string | null }
  | { kind: 'flag'; read?: (row: T) => boolean | null | UnknownValue }
);

/** A list's filterable fields by catalog field ID. */
export type ListFields<T> = Readonly<Record<string, ListField<T>>>;

/** The read clock and the reader's zone, which days and relative periods resolve against. */
export interface ListClock {
  now: Date;
  timeZone: string;
}

/** Conditions split into what the store applies in SQL and what memory evaluates. */
export interface ListWherePlan<T> {
  stored: StoredWhere | null;
  memory: ((row: T) => boolean) | null;
}

/** A 400 error with a message people can act on. */
export function listQueryError(message: string) {
  return Object.assign(new Error(message), { statusCode: 400, expose: true });
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A condition with its values checked and dates resolved. */
type Resolved =
  | { op: 'empty' | 'not_empty' | 'unknown' }
  | { op: 'any_of' | 'none_of' | 'all_of'; values: string[] }
  | { op: 'contains' | 'not_contains' | 'is' | 'is_not'; text: string }
  | { op: 'flag'; value: boolean }
  | { op: 'range'; from: Bound | null; to: Bound | null }
  | {
      op: 'quantity';
      test: (value: Decimal) => boolean;
      /** The same test as comparisons that must all hold, for the store. */
      comparisons: StoredComparison[];
      currency?: string;
    };

/** An instant (ISO) or a calendar day (`YYYY-MM-DD`), depending on the field. */
interface Bound {
  value: string;
  inclusive: boolean;
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function isRange(
  value: ListValue | undefined,
): value is { from: ListRangeBound; to: ListRangeBound } {
  return isObject(value) && 'from' in value && 'to' in value;
}

function isRelative(value: ListValue | undefined): value is ListRelativeValue {
  return isObject(value) && 'unit' in value && 'amount' in value;
}

function isAmount(
  value: ListValue | ListRangeBound | undefined,
): value is Amount {
  return isObject(value) && 'currency' in value && 'amount' in value;
}

function text(value: ListValue | undefined): string {
  if (typeof value !== 'string') throw listQueryError('Expected text');

  return value;
}

function values(value: ListValue | undefined, ids: boolean): string[] {
  if (!Array.isArray(value))
    throw listQueryError('This operator needs a list of values');

  return [
    ...new Set(
      value.map((item) => {
        if (typeof item !== 'string') throw listQueryError('Expected text');
        if (ids && !uuid.test(item))
          throw listQueryError('This value is not a valid record ID');

        return ids ? item.toLowerCase() : item;
      }),
    ),
  ];
}

/** A calendar day or an exact instant, as a date condition names it. */
type Moment = { day: LocalDate } | { at: Date };

function moment(
  value: ListValue | ListRangeBound | undefined,
  clock: ListClock,
): Moment {
  if (isObject(value) && 'dynamic' in value && value.dynamic === 'today')
    return { day: localDate(clock.now, clock.timeZone) };
  if (typeof value === 'string') {
    const day = parseLocalDate(value);
    if (day) return { day };
    const at = parseInstant(value);
    if (at) return { at };
  }
  throw listQueryError(
    'Dates need a day (YYYY-MM-DD), a time with an offset or today',
  );
}

/** The lower and upper bound of a date condition; null where it is open. */
interface Range {
  from: Bound | null;
  to: Bound | null;
}

/** The day `within_last` starts on or `within_next` ends on. */
function relativeDay(condition: ListCondition, clock: ListClock) {
  const { op, value } = condition;
  if (!isRelative(value))
    throw listQueryError('A relative period needs an amount and unit');

  return shiftLocalDate(
    localDate(clock.now, clock.timeZone),
    op === 'within_last' ? -value.amount : value.amount,
    value.unit,
  );
}

/**
 * Resolves a date condition on instants. A day covers the whole local day in the reader's zone;
 * `within_last` runs from the start of the local day n units ago to the read time and
 * `within_next` from the read time to the end of the local day n units ahead. Times with an
 * offset compare exactly.
 */
function instantRange(condition: ListCondition, clock: ListClock): Range {
  const { op, value } = condition;
  const start = (day: LocalDate) =>
    startOfLocalDay(day, clock.timeZone).toISOString();
  const next = (day: LocalDate) => start(shiftLocalDate(day, 1, 'day'));
  const now = clock.now.toISOString();
  if (op === 'before') {
    const bound = moment(value, clock);

    return {
      from: null,
      to: {
        value: 'day' in bound ? start(bound.day) : bound.at.toISOString(),
        inclusive: false,
      },
    };
  }
  if (op === 'after') {
    const bound = moment(value, clock);

    return {
      from:
        'day' in bound
          ? { value: next(bound.day), inclusive: true }
          : { value: bound.at.toISOString(), inclusive: false },
      to: null,
    };
  }
  if (op === 'between') {
    const [from, to] = rangeMoments(value, clock);

    return {
      from: from && {
        value: 'day' in from ? start(from.day) : from.at.toISOString(),
        inclusive: true,
      },
      to: to && {
        value: 'day' in to ? next(to.day) : to.at.toISOString(),
        inclusive: !('day' in to),
      },
    };
  }
  if (op === 'within_last' || op === 'within_next') {
    const day = relativeDay(condition, clock);

    return op === 'within_last'
      ? {
          from: { value: start(day), inclusive: true },
          to: { value: now, inclusive: true },
        }
      : {
          from: { value: now, inclusive: true },
          to: { value: next(day), inclusive: false },
        };
  }
  throw listQueryError('This field does not support this operator');
}

/**
 * Resolves a date condition on calendar days, which compare as days directly. A time with an
 * offset names the local day it falls on in the reader's zone.
 */
function dayRange(condition: ListCondition, clock: ListClock): Range {
  const { op, value } = condition;
  const day = (bound: Moment) =>
    formatLocalDate(
      'day' in bound ? bound.day : localDate(bound.at, clock.timeZone),
    );
  const today = localDate(clock.now, clock.timeZone);
  if (op === 'before')
    return {
      from: null,
      to: { value: day(moment(value, clock)), inclusive: false },
    };
  if (op === 'after')
    return {
      from: { value: day(moment(value, clock)), inclusive: false },
      to: null,
    };
  if (op === 'between') {
    const [from, to] = rangeMoments(value, clock);

    return {
      from: from && { value: day(from), inclusive: true },
      to: to && { value: day(to), inclusive: true },
    };
  }
  if (op === 'within_last' || op === 'within_next') {
    const shifted = formatLocalDate(relativeDay(condition, clock));
    const current = formatLocalDate(today);

    return op === 'within_last'
      ? {
          from: { value: shifted, inclusive: true },
          to: { value: current, inclusive: true },
        }
      : {
          from: { value: current, inclusive: true },
          to: { value: shifted, inclusive: true },
        };
  }
  throw listQueryError('This field does not support this operator');
}

/** The two ends of a `between` date condition; at least one is set. */
function rangeMoments(
  value: ListValue | undefined,
  clock: ListClock,
): [Moment | null, Moment | null] {
  if (!isRange(value)) throw listQueryError('A range needs a start or an end');
  const from = value.from === null ? null : moment(value.from, clock);
  const to = value.to === null ? null : moment(value.to, clock);
  if (!from && !to) throw listQueryError('A range needs a start or an end');

  return [from, to];
}

function decimal(text: string): Decimal {
  const parsed = parseDecimal(text);
  if (!parsed) throw listQueryError('Expected a number');

  return parsed;
}

const comparisons: Partial<Record<ListOperator, (order: number) => boolean>> = {
  eq: (order) => order === 0,
  ne: (order) => order !== 0,
  gt: (order) => order > 0,
  gte: (order) => order >= 0,
  lt: (order) => order < 0,
  lte: (order) => order <= 0,
};

function isComparison(op: ListOperator): op is StoredComparison['op'] {
  return Object.hasOwn(comparisons, op);
}

/** Resolves a number or money condition; money compares only within one currency. */
function quantity(condition: ListCondition, money: boolean): Resolved {
  const { op, value } = condition;
  const bound = (item: ListValue | ListRangeBound | undefined) => {
    if (money) {
      if (!isAmount(item)) throw listQueryError('Amounts need a currency');

      return {
        amount: decimal(item.amount),
        currency: item.currency,
        text: item.amount,
      };
    }
    if (typeof item !== 'number' || !Number.isFinite(item))
      throw listQueryError('Expected a number');

    return {
      amount: decimal(String(item)),
      currency: undefined,
      text: String(item),
    };
  };
  if (op === 'between') {
    if (!isRange(value))
      throw listQueryError('A range needs a start or an end');
    const from = value.from === null ? null : bound(value.from);
    const to = value.to === null ? null : bound(value.to);
    if (!from && !to) throw listQueryError('A range needs a start or an end');
    if (from && to && from.currency !== to.currency)
      throw listQueryError(
        'Both ends of an amount range need the same currency',
      );
    const currency = from?.currency ?? to?.currency;

    return {
      op: 'quantity',
      ...(currency ? { currency } : {}),
      comparisons: [
        ...(from ? [{ op: 'gte' as const, value: from.text }] : []),
        ...(to ? [{ op: 'lte' as const, value: to.text }] : []),
      ],
      test: (amount) =>
        (!from || compareDecimals(amount, from.amount) >= 0) &&
        (!to || compareDecimals(amount, to.amount) <= 0),
    };
  }
  const compare = comparisons[op];
  if (!compare || !isComparison(op))
    throw listQueryError('This field does not support this operator');
  const { amount, currency, text } = bound(value);

  return {
    op: 'quantity',
    ...(currency ? { currency } : {}),
    comparisons: [{ op, value: text }],
    test: (candidate) => compare(compareDecimals(candidate, amount)),
  };
}

function resolve<T>(
  field: ListField<T>,
  condition: ListCondition,
  clock: ListClock,
): Resolved {
  const { op, value } = condition;
  if (op === 'empty' || op === 'not_empty' || op === 'unknown') return { op };
  switch (field.kind) {
    case 'text':
    case 'texts':
      if (
        op === 'contains' ||
        op === 'not_contains' ||
        op === 'is' ||
        op === 'is_not'
      )
        return { op, text: text(value) };
      break;
    case 'choice':
    case 'choices':
      if (op === 'any_of' || op === 'none_of' || op === 'all_of')
        return { op, values: values(value, !!field.ids) };
      break;
    case 'flag':
      if (op === 'is') {
        if (typeof value !== 'boolean')
          throw listQueryError('Expected true or false');

        return { op: 'flag', value };
      }
      break;
    case 'number':
    case 'money':
      return quantity(condition, field.kind === 'money');
    case 'instant':
      return { op: 'range', ...instantRange(condition, clock) };
    case 'day':
      return { op: 'range', ...dayRange(condition, clock) };
  }
  throw listQueryError('This field does not support this operator');
}

/** The SQL form of a resolved condition, when the field's store supports its operator. */
function stored<T>(
  id: string,
  field: ListField<T>,
  op: ListOperator,
  resolved: Resolved,
): StoredCondition | null {
  if (!field.stored?.includes(op)) return null;
  const instant = (bound: Bound | null): StoredBound | null =>
    bound && { at: bound.value, inclusive: bound.inclusive };
  switch (resolved.op) {
    case 'empty':
    case 'not_empty':
      return { field: id, op: resolved.op };
    case 'any_of':
    case 'none_of':
    case 'all_of':
      return { field: id, op: resolved.op, values: resolved.values };
    case 'contains':
    case 'not_contains':
    case 'is':
    case 'is_not':
      return { field: id, op: resolved.op, text: resolved.text };
    case 'flag':
      return { field: id, op: 'flag', value: resolved.value };
    // Only plain numbers compare in SQL; amounts need their currency.
    case 'quantity':
      return field.kind === 'number' && !resolved.currency
        ? { field: id, op: 'compare', comparisons: resolved.comparisons }
        : null;
    // Instant fields compare instants; day fields compare calendar days.
    case 'range':
      return field.kind === 'instant' || field.kind === 'day'
        ? {
            field: id,
            op: 'range',
            from: instant(resolved.from),
            to: instant(resolved.to),
          }
        : null;
    default:
      return null;
  }
}

function inRange(value: string, range: Range, days: boolean) {
  const compare = (a: string, b: string) =>
    days ? (a < b ? -1 : a > b ? 1 : 0) : Date.parse(a) - Date.parse(b);
  if (range.from) {
    const order = compare(value, range.from.value);
    if (order < 0 || (order === 0 && !range.from.inclusive)) return false;
  }
  if (range.to) {
    const order = compare(value, range.to.value);
    if (order > 0 || (order === 0 && !range.to.inclusive)) return false;
  }

  return true;
}

const lower = (value: string) => value.toLowerCase();

/** Matches one row's value. Empty and unknown values never match comparisons. */
function matcher<T>(
  field: ListField<T>,
  resolved: Resolved,
): ((row: T) => boolean) | null {
  const normalize = (value: string) => (field.ids ? lower(value) : value);
  switch (field.kind) {
    case 'text':
    case 'choice': {
      const read = field.read;
      if (!read) return null;
      if (resolved.op === 'empty') return (row) => read(row) === null;
      if (resolved.op === 'not_empty') return (row) => read(row) !== null;
      if (resolved.op === 'unknown') return () => false;
      if (resolved.op === 'any_of' || resolved.op === 'none_of') {
        const wanted = new Set(resolved.values);
        const has = (row: T) => {
          const value = read(row);

          return value !== null && wanted.has(normalize(value));
        };

        return resolved.op === 'any_of' ? has : (row) => !has(row);
      }
      if (resolved.op === 'contains' || resolved.op === 'not_contains') {
        const needle = lower(resolved.text);
        const has = (row: T) => {
          const value = read(row);

          return value !== null && lower(value).includes(needle);
        };

        return resolved.op === 'contains' ? has : (row) => !has(row);
      }
      if (resolved.op === 'is' || resolved.op === 'is_not') {
        const wanted = resolved.text;

        return resolved.op === 'is'
          ? (row) => read(row) === wanted
          : (row) => read(row) !== wanted;
      }
      break;
    }
    case 'texts':
    case 'choices': {
      const read = field.read;
      if (!read) return null;
      const all = (row: T) => read(row).map(normalize);
      if (resolved.op === 'empty') return (row) => read(row).length === 0;
      if (resolved.op === 'not_empty') return (row) => read(row).length > 0;
      if (resolved.op === 'unknown') return () => false;
      if (resolved.op === 'any_of' || resolved.op === 'none_of') {
        const wanted = new Set(resolved.values);
        const has = (row: T) => all(row).some((value) => wanted.has(value));

        return resolved.op === 'any_of' ? has : (row) => !has(row);
      }
      if (resolved.op === 'all_of') {
        const wanted = resolved.values;

        return (row) => {
          const present = new Set(all(row));

          return wanted.every((value) => present.has(value));
        };
      }
      if (resolved.op === 'contains' || resolved.op === 'not_contains') {
        const needle = lower(resolved.text);
        const has = (row: T) =>
          read(row).some((value) => lower(value).includes(needle));

        return resolved.op === 'contains' ? has : (row) => !has(row);
      }
      if (resolved.op === 'is' || resolved.op === 'is_not') {
        const wanted = resolved.text;
        const has = (row: T) => read(row).includes(wanted);

        return resolved.op === 'is' ? has : (row) => !has(row);
      }
      break;
    }
    case 'number':
    case 'money': {
      const read = field.read;
      if (!read) return null;
      if (resolved.op === 'empty') return (row) => read(row) === null;
      if (resolved.op === 'not_empty')
        return (row) => {
          const value = read(row);

          return value !== null && value !== unknownValue;
        };
      if (resolved.op === 'unknown') return (row) => read(row) === unknownValue;
      if (resolved.op === 'quantity') {
        const { test, currency } = resolved;

        return (row) => {
          const value = read(row);
          if (value === null || value === unknownValue) return false;
          if (typeof value === 'number') return test(decimal(String(value)));
          if (value.currency !== currency) return false;
          const amount = parseDecimal(value.amount);

          return amount !== null && test(amount);
        };
      }
      break;
    }
    case 'instant':
    case 'day': {
      const read = field.read;
      if (!read) return null;
      if (resolved.op === 'empty') return (row) => read(row) === null;
      if (resolved.op === 'not_empty') return (row) => read(row) !== null;
      if (resolved.op === 'unknown') return () => false;
      if (resolved.op === 'range') {
        const days = field.kind === 'day';

        return (row) => {
          const value = read(row);

          return value !== null && inRange(value, resolved, days);
        };
      }
      break;
    }
    case 'flag': {
      const read = field.read;
      if (!read) return null;
      if (resolved.op === 'empty') return (row) => read(row) === null;
      if (resolved.op === 'not_empty')
        return (row) => typeof read(row) === 'boolean';
      if (resolved.op === 'unknown') return (row) => read(row) === unknownValue;
      if (resolved.op === 'flag') {
        const wanted = resolved.value;

        return (row) => read(row) === wanted;
      }
      break;
    }
  }
  throw listQueryError('This field does not support this operator');
}

/**
 * Compiles catalog conditions against a list's fields and splits them into what the store
 * applies in SQL and what memory evaluates. With `match: all`, conditions the store supports go
 * to SQL and the rest to memory; with `match: any`, all go to SQL only when the store supports
 * every one, otherwise memory evaluates all of them.
 *
 * Rules shared with the collection SQL: comparisons never match empty or unknown values;
 * `none_of`, `is_not` and `not_contains` match empty but never unknown values; `empty` matches
 * empty values only; booleans match only a known true or false. Amounts compare only within one
 * currency, and an amount range needs one currency for both ends. Fields with several values,
 * such as line SKUs, match when any value does; their negative operators match when none does.
 *
 * Throws a 400 error naming the condition for unknown fields, unsupported operators and
 * malformed values.
 */
export function planListWhere<T>(
  where: ListWhere | undefined,
  fields: ListFields<T>,
  clock: ListClock,
): ListWherePlan<T> {
  if (!where?.conditions.length) return { stored: null, memory: null };
  const compiled = where.conditions.map((condition, index) => {
    try {
      const field = Object.hasOwn(fields, condition.field)
        ? fields[condition.field]
        : undefined;
      if (!field) throw listQueryError('This field cannot be filtered');
      if (condition.source)
        throw listQueryError('This field has one value for all sources');
      if (!field.operators.includes(condition.op))
        throw listQueryError('This field does not support this operator');
      const resolved = resolve(field, condition, clock);

      return {
        stored: stored(condition.field, field, condition.op, resolved),
        matches: matcher(field, resolved),
      };
    } catch (error) {
      if (error instanceof Error && 'statusCode' in error)
        throw listQueryError(
          `Condition ${index + 1}: ${error.message.replace(/\.$/, '')}.`,
        );
      throw error;
    }
  });
  const memoryOnly = (index: number) => {
    const test = compiled[index]?.matches;
    if (!test)
      throw listQueryError(
        `Condition ${index + 1}: This field cannot be combined with these conditions.`,
      );

    return test;
  };
  if (where.match === 'any') {
    if (compiled.every((condition) => condition.stored))
      return {
        stored: {
          match: 'any',
          conditions: compiled.flatMap((condition) =>
            condition.stored ? [condition.stored] : [],
          ),
        },
        memory: null,
      };
    const tests = compiled.map((_, index) => memoryOnly(index));

    return { stored: null, memory: (row) => tests.some((test) => test(row)) };
  }
  const storedConditions = compiled.flatMap((condition) =>
    condition.stored ? [condition.stored] : [],
  );
  const tests = compiled.flatMap((condition, index) =>
    condition.stored ? [] : [memoryOnly(index)],
  );

  return {
    stored: storedConditions.length
      ? { match: 'all', conditions: storedConditions }
      : null,
    memory: tests.length ? (row) => tests.every((test) => test(row)) : null,
  };
}
