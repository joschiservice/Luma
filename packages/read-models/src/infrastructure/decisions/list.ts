import type {
  CollectionCondition,
  CollectionGroupKey,
  CollectionGroupResult,
  CollectionRangeBound,
  CollectionValue,
  CollectionWhere,
} from '../../application/collections.js';
import type { DecisionItem } from '../../application/decisions.js';
import {
  type LocalDate,
  localDate,
  parseInstant,
  parseLocalDate,
  shiftLocalDate,
  startOfLocalDay,
} from '../collection/dates.js';
import { collectionQueryError } from '../collection/parameters.js';

// Needs you holds only decisions waiting on a person, and every owner presents its decisions
// in memory before ranking. The queue is therefore read whole and its conditions, search, sort,
// groups and pages are evaluated here rather than in SQL.

/** A decision as the queue ranked it, with the keys its sorts use. */
export interface RankedDecision {
  item: DecisionItem;
  /** 0 expires within the window, 1 high impact, 2 the rest. */
  rank: number;
  /** The deadline as sortable text, `infinity` when nothing expires. */
  deadlineKey: string;
}

/** What conditions resolve against: the reader, the ranking time and the reader's zone. */
export interface DecisionListContext {
  readerId: string;
  now: Date;
  timeZone: string;
}

type Read = (decision: DecisionItem) => string | null;

const choices: Readonly<Record<string, Read>> = {
  domain: (item) => item.domain,
  reason: (item) => item.reason,
  impact: (item) => item.impact.level,
  owner: (item) => item.assignment?.assigneeId ?? null,
};

const dates: Readonly<Record<string, Read>> = {
  deadline: (item) => item.deadline,
  requested: (item) => item.requestedAt,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRange(
  value: unknown,
): value is { from: CollectionRangeBound; to: CollectionRangeBound } {
  return isObject(value) && 'from' in value && 'to' in value;
}

/** Values of a list condition, with `me` resolved to the reader. */
function listed(condition: CollectionCondition, readerId: string) {
  if (!Array.isArray(condition.value) || !condition.value.length)
    throw collectionQueryError('This operator needs a list of values');

  return new Set(
    condition.value.map((value) => {
      const resolved =
        isObject(value) && value.dynamic === 'me' ? readerId : value;
      if (typeof resolved !== 'string')
        throw collectionQueryError('Expected text values');

      return condition.field === 'owner' ? resolved.toLowerCase() : resolved;
    }),
  );
}

/** A date bound as the first matching or first excluded instant. */
interface Bound {
  start: number;
  end: number;
  /** An exact instant rather than a whole local day. */
  instant: boolean;
}

function bound(
  value: CollectionValue | CollectionRangeBound | undefined,
  context: DecisionListContext,
): Bound {
  const day = (date: LocalDate): Bound => ({
    start: startOfLocalDay(date, context.timeZone).getTime(),
    end: startOfLocalDay(
      shiftLocalDate(date, 1, 'day'),
      context.timeZone,
    ).getTime(),
    instant: false,
  });
  if (isObject(value) && value.dynamic === 'today')
    return day(localDate(context.now, context.timeZone));
  if (typeof value === 'string') {
    const date = parseLocalDate(value);
    if (date) return day(date);
    const at = parseInstant(value);
    if (at) return { start: at.getTime(), end: at.getTime(), instant: true };
  }
  throw collectionQueryError(
    'Dates need a day (YYYY-MM-DD), a time with an offset or today',
  );
}

/** Compiles a date condition, with whole local days in the reader's zone. */
function datePredicate(
  condition: CollectionCondition,
  context: DecisionListContext,
): (at: number) => boolean {
  const { op, value } = condition;
  const now = context.now.getTime();
  if (op === 'before') {
    const { start } = bound(value, context);

    return (at) => at < start;
  }
  if (op === 'after') {
    const { end, instant } = bound(value, context);

    return (at) => (instant ? at > end : at >= end);
  }
  if (op === 'between') {
    if (!isRange(value))
      throw collectionQueryError('A range needs a start or an end');
    const from = value.from === null ? null : bound(value.from, context);
    const to = value.to === null ? null : bound(value.to, context);

    return (at) =>
      (!from || at >= from.start) &&
      (!to || (to.instant ? at <= to.end : at < to.end));
  }
  if (op === 'within_last' || op === 'within_next') {
    if (
      !isObject(value) ||
      typeof value.amount !== 'number' ||
      (value.unit !== 'day' && value.unit !== 'week' && value.unit !== 'month')
    )
      throw collectionQueryError('A relative period needs an amount and unit');
    const today = localDate(context.now, context.timeZone);
    if (op === 'within_last') {
      const from = startOfLocalDay(
        shiftLocalDate(today, -value.amount, value.unit),
        context.timeZone,
      ).getTime();

      return (at) => at >= from && at <= now;
    }
    const until = startOfLocalDay(
      shiftLocalDate(shiftLocalDate(today, value.amount, value.unit), 1, 'day'),
      context.timeZone,
    ).getTime();

    return (at) => at >= now && at < until;
  }
  throw collectionQueryError('This field does not support this operator');
}

/**
 * Compiles one condition into a test of a decision. Throws a 400 error for unknown fields,
 * unsupported operators and malformed values, whether or not any decision would be tested.
 */
function predicate(
  condition: CollectionCondition,
  context: DecisionListContext,
): (item: DecisionItem) => boolean {
  if (condition.source)
    throw collectionQueryError('This field has one value for all sources');
  const { field, op } = condition;
  const choice = Object.hasOwn(choices, field) ? choices[field] : undefined;
  const date = Object.hasOwn(dates, field) ? dates[field] : undefined;
  const read = choice ?? date;
  if (!read) throw collectionQueryError('This field cannot be filtered');
  if (op === 'empty') return (item) => read(item) === null;
  if (op === 'not_empty') return (item) => read(item) !== null;
  if (date) {
    const test = datePredicate(condition, context);

    return (item) => {
      const value = date(item);

      return value !== null && test(Date.parse(value));
    };
  }
  if (op === 'any_of' || op === 'none_of') {
    const values = listed(condition, context.readerId);

    return op === 'any_of'
      ? (item) => {
          const value = read(item);

          return value !== null && values.has(value);
        }
      : (item) => {
          const value = read(item);

          return value === null || !values.has(value);
        };
  }
  throw collectionQueryError('This field does not support this operator');
}

/**
 * Keeps the decisions that satisfy the conditions and whose title contains the search text,
 * ignoring case. Malformed conditions answer 400 even when the queue is empty.
 */
export function filterDecisions<T extends RankedDecision>(
  decisions: readonly T[],
  where: CollectionWhere | undefined,
  q: string | undefined,
  context: DecisionListContext,
) {
  const tests = (where?.conditions ?? []).map((condition) =>
    predicate(condition, context),
  );
  const text = q?.trim().toLocaleLowerCase();

  return decisions.filter(({ item }) => {
    if (text && !item.title.toLocaleLowerCase().includes(text)) return false;
    if (!tests.length) return true;

    return where?.match === 'any'
      ? tests.some((test) => test(item))
      : tests.every((test) => test(item));
  });
}

/** One decision's position in a sort: the keys in order, then the ID. */
export type DecisionKeys = (string | number)[];

/**
 * The keys a sort orders by. Decisions without a deadline come last in both directions for
 * `deadline`; `urgency` is the queue's ranking.
 */
export function decisionKeys(
  decision: RankedDecision,
  sort: 'urgency' | 'deadline' | 'requested',
): DecisionKeys {
  const { item } = decision;
  if (sort === 'deadline')
    return item.deadline === null
      ? [1, 0, item.id]
      : [0, Date.parse(item.deadline), item.id];
  if (sort === 'requested') return [0, Date.parse(item.requestedAt), item.id];

  return [
    0,
    decision.rank,
    // Cursors carry keys as JSON, which has no infinity.
    decision.deadlineKey === 'infinity'
      ? Number.MAX_SAFE_INTEGER
      : Date.parse(decision.deadlineKey),
    Date.parse(item.requestedAt),
    item.id,
  ];
}

/**
 * Compares two positions in the sort direction; the first key (whether the value is missing)
 * always puts missing values last.
 */
export function compareKeys(
  left: DecisionKeys,
  right: DecisionKeys,
  direction: 'asc' | 'desc',
) {
  for (const [index, value] of left.entries()) {
    const other = right[index];
    if (other === undefined || value === other) continue;
    const order =
      typeof value === 'number' && typeof other === 'number'
        ? value - other
        : String(value) < String(other)
          ? -1
          : 1;

    return index === 0 || direction === 'asc' ? order : -order;
  }

  return left.length - right.length;
}

/** How Needs you groups decisions; `null` is the group without a value. */
const groupKeys: Readonly<
  Record<string, (item: DecisionItem) => string | null>
> = {
  domain: (item) => item.domain,
  reason: (item) => item.reason,
  owner: (item) => item.assignment?.assigneeId ?? null,
  cause: (item) => item.group.key,
};

/** The group of a decision, or a 400 error for fields Needs you can't group by. */
export function decisionGroupKey(field: string) {
  const key = Object.hasOwn(groupKeys, field) ? groupKeys[field] : undefined;
  if (!key) throw collectionQueryError('This field cannot be grouped');

  return key;
}

/**
 * Groups sorted decisions. Areas and reasons follow `options`, the catalog's order; owners and
 * causes follow their most urgent decision. The group without a value comes last. Each group
 * keeps its first `perGroup` decisions and a cursor for the rest.
 */
export function groupDecisions<T extends RankedDecision>(
  sorted: readonly T[],
  field: string,
  options: Readonly<Record<string, readonly string[]>>,
  perGroup: number,
  complete: boolean,
  cursor: (key: CollectionGroupKey, last: T) => string,
): { groups: CollectionGroupResult[]; truncated: boolean; shown: T[] } {
  const keyOf = decisionGroupKey(field);
  const members = new Map<string | null, T[]>();
  for (const decision of sorted) {
    const key = keyOf(decision.item);
    const group = members.get(key) ?? [];
    group.push(decision);
    members.set(key, group);
  }
  const order = options[field];
  const keys = [...members.keys()].sort((left, right) => {
    if (left === null || right === null) return left === null ? 1 : -1;
    if (!order) return 0;
    const position = (key: string) => {
      const index = order.indexOf(key);

      return index < 0 ? order.length : index;
    };

    return position(left) - position(right);
  });
  const maxGroups = 50;
  const shown: T[] = [];
  const groups = keys.slice(0, maxGroups).map((key) => {
    const all = members.get(key) ?? [];
    const head = all.slice(0, perGroup);
    shown.push(...head);
    const last = head.at(-1);

    return {
      key,
      count: all.length,
      complete,
      itemIds: head.map((decision) => decision.item.id),
      nextCursor: last && all.length > head.length ? cursor(key, last) : null,
      sums: [],
    };
  });

  return { groups, truncated: keys.length > maxGroups, shown };
}
