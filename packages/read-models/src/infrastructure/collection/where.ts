import type {
  CollectionCondition,
  CollectionDynamicValue,
  CollectionFieldType,
  CollectionMoneyValue,
  CollectionRangeBound,
  CollectionRelativeValue,
  CollectionValue,
  CollectionWhere,
} from '../../application/collections.js';
import {
  type LocalDate,
  localDate,
  parseInstant,
  parseLocalDate,
  shiftLocalDate,
  startOfLocalDay,
} from './dates.js';
import {
  collectionQueryError,
  type CollectionSqlCast,
  likePattern,
  type SqlParameters,
} from './parameters.js';

/** Everything a condition may resolve against at read time. */
export interface CollectionCompileContext {
  parameters: SqlParameters;
  /** The read clock; relative periods and `today` resolve against it. */
  now: Date;
  /** IANA zone whose calendar days, weeks and months relative dates use. */
  timeZone: string;
  /** The caller's user ID, for `{ dynamic: 'me' }`. */
  userId: string;
}

/**
 * How one list field filters in SQL. Every SQL fragment refers to the list row as `o` and may
 * use the list query's own fixed parameters (for example `$1` tenant, `$2` read time).
 *
 * Null means the source reported no value (`empty`). When `unknown` is set, rows where it is
 * true match only the `unknown` operator: never a comparison, `empty` or a negative operator.
 */
export interface CollectionFieldSql {
  type: CollectionFieldType;
  /** The value: a scalar for most types, a text array for tags, the amount for money. */
  sql?: string;
  /** Money only: the ISO currency of `sql`. Amounts compare only within one currency. */
  currency?: string;
  /** True when Luma cannot know the value, distinct from a reported empty value. */
  unknown?: string;
  /** Cast for bound values; defaults by type (`uuid` suits references to Luma records). */
  cast?: CollectionSqlCast;
  /**
   * Compiles a condition the generic operators cannot express, such as a relation, a
   * per-source scope or a permission-dependent join. Return undefined to use the generic rule.
   */
  predicate?: (
    condition: CollectionCondition,
    context: CollectionCompileContext,
  ) => string | undefined;
  /** Named query parts (such as CTEs) this field's SQL reads; the list adds them when used. */
  requires?: readonly string[];
}

/** A list's filterable fields by catalog field ID. */
export type CollectionFieldMap = Readonly<Record<string, CollectionFieldSql>>;

/** A compiled `where`: one parameterized predicate and the query parts it needs. */
export interface CompiledWhere {
  sql: string;
  requires: Set<string>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isDynamic(value: unknown): value is CollectionDynamicValue {
  return typeof value === 'object' && value !== null && 'dynamic' in value;
}

function isMoney(value: unknown): value is CollectionMoneyValue {
  return typeof value === 'object' && value !== null && 'currency' in value;
}

function isRelative(value: unknown): value is CollectionRelativeValue {
  return typeof value === 'object' && value !== null && 'unit' in value;
}

function isRange(
  value: unknown,
): value is { from: CollectionRangeBound; to: CollectionRangeBound } {
  return typeof value === 'object' && value !== null && 'from' in value;
}

function defaultCast(type: CollectionFieldType): CollectionSqlCast {
  return type === 'number' || type === 'money'
    ? 'numeric'
    : type === 'boolean'
      ? 'boolean'
      : type === 'date'
        ? 'timestamptz'
        : 'text';
}

/** Resolves `me` and checks one list or single value against the field's cast. */
function scalar(
  value: CollectionValue | CollectionRangeBound | undefined,
  cast: CollectionSqlCast,
  context: CollectionCompileContext,
): string | number | boolean {
  const resolved = isDynamic(value)
    ? value.dynamic === 'me'
      ? context.userId
      : undefined
    : value;
  if (
    resolved === undefined ||
    resolved === null ||
    typeof resolved === 'object'
  )
    throw collectionQueryError('This condition needs a single value');
  if (cast === 'uuid' && (typeof resolved !== 'string' || !uuid.test(resolved)))
    throw collectionQueryError('This value is not a valid record ID');
  if (
    (cast === 'numeric' || cast === 'integer') &&
    (typeof resolved !== 'number' || !Number.isFinite(resolved))
  )
    throw collectionQueryError('Expected a number');
  if (cast === 'boolean' && typeof resolved !== 'boolean')
    throw collectionQueryError('Expected true or false');
  if (cast === 'text' && typeof resolved !== 'string')
    throw collectionQueryError('Expected text');

  return resolved;
}

function list(
  value: CollectionValue | undefined,
  cast: CollectionSqlCast,
  context: CollectionCompileContext,
) {
  if (!Array.isArray(value))
    throw collectionQueryError('This operator needs a list of values');

  return [...new Set(value.map((item) => scalar(item, cast, context)))];
}

/**
 * Resolves a list condition's values (`me` becomes the caller) and checks each against
 * `cast`, for field predicate hooks. Throws a 400 error for malformed values.
 */
export function conditionValues(
  condition: CollectionCondition,
  cast: CollectionSqlCast,
  context: CollectionCompileContext,
) {
  return list(condition.value, cast, context);
}

/** A calendar day or an exact instant, as a date condition names it. */
type Moment = { day: LocalDate } | { at: Date };

function moment(
  value: CollectionValue | CollectionRangeBound | undefined,
  context: CollectionCompileContext,
): Moment {
  if (isDynamic(value) && value.dynamic === 'today')
    return { day: localDate(context.now, context.timeZone) };
  if (typeof value === 'string') {
    const day = parseLocalDate(value);
    if (day) return { day };
    const at = parseInstant(value);
    if (at) return { at };
  }
  throw collectionQueryError(
    'Dates need a day (YYYY-MM-DD), a time with an offset or today',
  );
}

function money(
  value: CollectionValue | CollectionRangeBound | undefined,
): CollectionMoneyValue {
  if (!isMoney(value)) throw collectionQueryError('Amounts need a currency');

  return value;
}

const comparisons = {
  eq: '=',
  ne: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
} as const;

/** The predicate for a date field, with whole local days resolved in the reader's time zone. */
function datePredicate(
  sql: string,
  condition: CollectionCondition,
  context: CollectionCompileContext,
): string {
  const { parameters, timeZone } = context;
  const at = (instant: Date) =>
    parameters.bind(instant.toISOString(), 'timestamptz');
  const start = (day: LocalDate) => at(startOfLocalDay(day, timeZone));
  const next = (day: LocalDate) => start(shiftLocalDate(day, 1, 'day'));
  const today = localDate(context.now, timeZone);
  const { op, value } = condition;
  if (op === 'before') {
    const bound = moment(value, context);

    return 'day' in bound
      ? `${sql} < ${start(bound.day)}`
      : `${sql} < ${at(bound.at)}`;
  }
  if (op === 'after') {
    const bound = moment(value, context);

    return 'day' in bound
      ? `${sql} >= ${next(bound.day)}`
      : `${sql} > ${at(bound.at)}`;
  }
  if (op === 'between') {
    if (!isRange(value))
      throw collectionQueryError('A range needs a start or an end');
    const parts: string[] = [];
    if (value.from !== null) {
      const from = moment(value.from, context);
      parts.push(`${sql} >= ${'day' in from ? start(from.day) : at(from.at)}`);
    }
    if (value.to !== null) {
      const to = moment(value.to, context);
      parts.push(
        'day' in to ? `${sql} < ${next(to.day)}` : `${sql} <= ${at(to.at)}`,
      );
    }

    return parts.length ? parts.join(' AND ') : `${sql} IS NOT NULL`;
  }
  if (op === 'within_last' || op === 'within_next') {
    if (!isRelative(value))
      throw collectionQueryError('A relative period needs an amount and unit');
    if (op === 'within_last') {
      const from = start(shiftLocalDate(today, -value.amount, value.unit));

      return `${sql} >= ${from} AND ${sql} <= ${at(context.now)}`;
    }
    const from = at(context.now);

    return `${sql} >= ${from} AND ${sql} < ${next(shiftLocalDate(today, value.amount, value.unit))}`;
  }
  throw collectionQueryError('This field does not support this operator');
}

/** The predicate for a number or money field; money compares only within its currency. */
function quantityPredicate(
  field: CollectionFieldSql,
  sql: string,
  condition: CollectionCondition,
  context: CollectionCompileContext,
): string {
  const { parameters } = context;
  const { op, value } = condition;
  if (field.type === 'money') {
    if (!field.currency) throw new Error('Money fields need a currency column');
    const amount = (bound: CollectionMoneyValue) =>
      parameters.bind(bound.amount, 'numeric');
    if (op === 'between') {
      if (!isRange(value))
        throw collectionQueryError('A range needs a start or an end');
      const from = value.from === null ? null : money(value.from);
      const to = value.to === null ? null : money(value.to);
      const currency = from?.currency ?? to?.currency;
      if (!currency || (from && to && from.currency !== to.currency))
        throw collectionQueryError(
          'Both ends of an amount range need the same currency',
        );

      return [
        `${field.currency} = ${parameters.bind(currency, 'text')}`,
        ...(from ? [`${sql} >= ${amount(from)}`] : []),
        ...(to ? [`${sql} <= ${amount(to)}`] : []),
      ].join(' AND ');
    }
    if (!(op in comparisons))
      throw collectionQueryError('This field does not support this operator');
    const bound = money(value);

    return `${field.currency} = ${parameters.bind(bound.currency, 'text')} AND ${sql} ${comparisons[op as keyof typeof comparisons]} ${amount(bound)}`;
  }
  const cast = field.cast ?? 'numeric';
  if (op === 'between') {
    if (!isRange(value))
      throw collectionQueryError('A range needs a start or an end');
    const parts = [
      ...(value.from === null
        ? []
        : [
            `${sql} >= ${parameters.bind(scalar(value.from, cast, context), cast)}`,
          ]),
      ...(value.to === null
        ? []
        : [
            `${sql} <= ${parameters.bind(scalar(value.to, cast, context), cast)}`,
          ]),
    ];

    return parts.join(' AND ');
  }
  if (!(op in comparisons))
    throw collectionQueryError('This field does not support this operator');

  return `${sql} ${comparisons[op as keyof typeof comparisons]} ${parameters.bind(scalar(value, cast, context), cast)}`;
}

/** The generic predicate for one condition; the caller excludes unknown values. */
function genericPredicate(
  field: CollectionFieldSql,
  condition: CollectionCondition,
  context: CollectionCompileContext,
): string {
  if (!field.sql) throw new Error('Collection field has no SQL value');
  // Compound expressions are parenthesized so operators never bind into them, such as `a OR b`;
  // a plain column or a single function call needs no parentheses.
  const sql = /^[\w.]+(?:\([^()]*\))?$/.test(field.sql)
    ? field.sql
    : `(${field.sql})`;
  const { parameters } = context;
  const cast = field.cast ?? defaultCast(field.type);
  const { op, value } = condition;
  if (op === 'empty')
    return field.type === 'tags'
      ? `(${sql} IS NULL OR cardinality(${sql})=0)`
      : `${sql} IS NULL`;
  if (op === 'not_empty')
    return field.type === 'tags'
      ? `cardinality(${sql})>0`
      : `${sql} IS NOT NULL`;
  if (field.type === 'date') return datePredicate(sql, condition, context);
  if (field.type === 'number' || field.type === 'money')
    return quantityPredicate(field, sql, condition, context);
  if (field.type === 'tags') {
    const values = parameters.bind(list(value, cast, context), `${cast}[]`);
    if (op === 'any_of') return `${sql} && ${values}`;
    if (op === 'all_of') return `${sql} @> ${values}`;
    if (op === 'none_of') return `NOT (COALESCE(${sql},'{}') && ${values})`;
  }
  if (op === 'any_of')
    return `${sql} = ANY(${parameters.bind(list(value, cast, context), `${cast}[]`)})`;
  if (op === 'none_of')
    return `(${sql} IS NULL OR ${sql} <> ALL(${parameters.bind(list(value, cast, context), `${cast}[]`)}))`;
  // A bare true condition keeps `IN (SELECT ...)` fields eligible for a join.
  if (op === 'is' && field.type === 'boolean' && value === true) return sql;
  if (op === 'is')
    return `${sql} = ${parameters.bind(scalar(value, cast, context), cast)}`;
  if (op === 'is_not')
    return `(${sql} IS NULL OR ${sql} <> ${parameters.bind(scalar(value, cast, context), cast)})`;
  if (op === 'contains' || op === 'not_contains') {
    const text = scalar(value, 'text', context);
    const pattern = parameters.bind(likePattern(String(text)), 'text');

    return op === 'contains'
      ? `${sql} ILIKE ${pattern}`
      : `(${sql} IS NULL OR ${sql} NOT ILIKE ${pattern})`;
  }
  throw collectionQueryError('This field does not support this operator');
}

/**
 * Compiles one condition. A row that does not match may yield NULL instead of false; WHERE,
 * AND and OR treat both alike, and leaving the predicate unwrapped lets PostgreSQL turn
 * `IN (SELECT ...)` conditions into joins.
 */
function conditionPredicate(
  field: CollectionFieldSql,
  condition: CollectionCondition,
  context: CollectionCompileContext,
): string {
  if (condition.op === 'unknown') {
    if (!field.unknown)
      throw collectionQueryError('This field does not support this operator');

    return `COALESCE((${field.unknown}),false)`;
  }
  const predicate =
    field.predicate?.(condition, context) ??
    genericPredicate(field, condition, context);

  return field.unknown
    ? `(NOT COALESCE((${field.unknown}),false) AND (${predicate}))`
    : `(${predicate})`;
}

/**
 * Compiles conditions into one parameterized SQL predicate over the list row `o`. Values are
 * bound through `context.parameters`; field SQL comes only from the trusted field map.
 *
 * Rules: comparisons (`eq`, `ne`, `gt`, ranges, dates) never match empty or unknown values;
 * negative set and text operators (`none_of`, `is_not`, `not_contains`) match empty but not
 * unknown values; `empty` matches reported-empty values only. Day values (`YYYY-MM-DD`,
 * `today`) cover whole local days in `context.timeZone`; `within_last n unit` runs from the
 * start of the local day n units ago up to the read time, `within_next` from the read time to
 * the end of the local day n units ahead.
 *
 * Use the result only as a WHERE condition and never negate it: a row that does not match
 * may evaluate to NULL rather than false. Throws a 400 error with a readable message for
 * unknown fields, unsupported operators and malformed values. Callers validate permissions
 * before compiling.
 */
export function compileWhere(
  where: CollectionWhere,
  fields: CollectionFieldMap,
  context: CollectionCompileContext,
): CompiledWhere {
  const requires = new Set<string>();
  const predicates = where.conditions.map((condition) => {
    const field = Object.hasOwn(fields, condition.field)
      ? fields[condition.field]
      : undefined;
    if (!field) throw collectionQueryError('This field cannot be filtered');
    for (const part of field.requires ?? []) requires.add(part);

    return conditionPredicate(field, condition, context);
  });

  return {
    sql: predicates.length
      ? `(${predicates.join(where.match === 'any' ? ' OR ' : ' AND ')})`
      : 'true',
    requires,
  };
}
