import { createHash } from 'node:crypto';

import { z } from 'zod';

import type {
  CaseCondition,
  CaseGroupKey,
  CaseQuery,
} from '../application/cases.js';
import type { Incident } from '../application/detection.js';

// Compiles the issue list's conditions, search, sort and grouping into bound SQL over the
// `listed` relation (aliased `l`), whose columns mirror what `project` presents. Field SQL comes
// only from this file; every request value is bound as a parameter.

/** A 400 error whose message is shown to the person who made the request. */
export function caseListError(message: string) {
  return Object.assign(new Error(message), { statusCode: 400, expose: true });
}

/** Appends values to the query's parameters and returns typed placeholders. */
export class CaseListParameters {
  constructor(readonly values: unknown[]) {}

  bind(value: unknown, cast: string) {
    this.values.push(value);

    return `$${this.values.length}::${cast}`;
  }
}

/** Everything a condition resolves against: the read time, the reader's zone and the reader. */
interface CompileContext {
  parameters: CaseListParameters;
  /** Placeholder of the read time, a timestamptz. */
  now: string;
  /** Placeholder of the reader's IANA zone. */
  zone: string;
  actorId: string;
}

type FieldKind = 'choice' | 'person' | 'tags' | 'date';

const fields: Readonly<Record<string, { kind: FieldKind; sql: string }>> = {
  class: { kind: 'choice', sql: 'l.class' },
  state: { kind: 'choice', sql: 'l.state' },
  severity: { kind: 'choice', sql: 'l.severity' },
  subjectType: { kind: 'choice', sql: 'l.subject_kind' },
  owner: { kind: 'person', sql: 'l.owner_id' },
  source: { kind: 'tags', sql: 'l.sources' },
  attention: { kind: 'choice', sql: 'l.attention_reason' },
  freshness: { kind: 'choice', sql: 'l.freshness' },
  diagnosis: { kind: 'choice', sql: 'l.diagnosis_status' },
  resolution: { kind: 'choice', sql: 'l.resolution' },
  detected: { kind: 'date', sql: 'l.detected_at' },
  lastActivity: { kind: 'date', sql: 'l.last_activity' },
  waitingSince: { kind: 'date', sql: 'l.waiting_since' },
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const day = /^\d{4}-\d{2}-\d{2}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The condition's list of values, with `me` resolved to the reader for people. */
function values(condition: CaseCondition, kind: FieldKind, actorId: string) {
  if (!Array.isArray(condition.value) || !condition.value.length)
    throw caseListError('This operator needs a list of values');
  const resolved: unknown[] = condition.value.map((value: unknown) =>
    kind === 'person' && isObject(value) && value.dynamic === 'me'
      ? actorId
      : value,
  );
  if (
    !resolved.every(
      (value): value is string =>
        typeof value === 'string' && (kind !== 'person' || uuid.test(value)),
    )
  )
    throw caseListError(
      kind === 'person'
        ? 'Choose people by their ID or as me'
        : 'Expected text values',
    );

  return [
    ...new Set(
      kind === 'person'
        ? resolved.map((value) => value.toLowerCase())
        : resolved,
    ),
  ];
}

/** A date bound: the start of a local day, the start of the following day, or an instant. */
function moment(value: unknown, context: CompileContext) {
  const { parameters, zone, now } = context;
  if (isObject(value) && value.dynamic === 'today') {
    const today = `(${now} AT TIME ZONE ${zone})::date`;

    return {
      start: `(${today}::timestamp AT TIME ZONE ${zone})`,
      end: `((${today}+1)::timestamp AT TIME ZONE ${zone})`,
    };
  }
  if (typeof value === 'string' && day.test(value)) {
    const bound = parameters.bind(value, 'date');

    return {
      start: `(${bound}::timestamp AT TIME ZONE ${zone})`,
      end: `((${bound}+1)::timestamp AT TIME ZONE ${zone})`,
    };
  }
  if (
    typeof value === 'string' &&
    value.includes('T') &&
    !Number.isNaN(Date.parse(value))
  ) {
    const at = parameters.bind(new Date(value).toISOString(), 'timestamptz');

    return { start: at, end: at, instant: true };
  }
  throw caseListError(
    'Dates need a day (YYYY-MM-DD), a time with an offset or today',
  );
}

const intervals = { day: 'days', week: 'weeks', month: 'months' } as const;

/** The predicate for a date field, with whole local days in the reader's zone. */
function datePredicate(
  sql: string,
  condition: CaseCondition,
  context: CompileContext,
) {
  const { op, value } = condition;
  const { parameters, now, zone } = context;
  if (op === 'before') return `${sql} < ${moment(value, context).start}`;
  if (op === 'after') {
    const bound = moment(value, context);

    return bound.instant ? `${sql} > ${bound.end}` : `${sql} >= ${bound.end}`;
  }
  if (op === 'between') {
    if (!isObject(value) || !('from' in value) || !('to' in value))
      throw caseListError('A range needs a start or an end');
    const parts = [
      ...(value.from === null
        ? []
        : [`${sql} >= ${moment(value.from, context).start}`]),
      ...(value.to === null
        ? []
        : [
            (() => {
              const bound = moment(value.to, context);

              return bound.instant
                ? `${sql} <= ${bound.end}`
                : `${sql} < ${bound.end}`;
            })(),
          ]),
    ];
    if (!parts.length) throw caseListError('A range needs a start or an end');

    return parts.join(' AND ');
  }
  if (op === 'within_last' || op === 'within_next') {
    if (
      !isObject(value) ||
      typeof value.amount !== 'number' ||
      !Number.isInteger(value.amount) ||
      value.amount < 0 ||
      !(typeof value.unit === 'string' && value.unit in intervals)
    )
      throw caseListError('A relative period needs an amount and unit');
    const unit = intervals[value.unit as keyof typeof intervals];
    const amount = parameters.bind(value.amount, 'integer');
    const today = `(${now} AT TIME ZONE ${zone})::date::timestamp`;

    return op === 'within_last'
      ? `${sql} >= ((${today} - make_interval(${unit}=>${amount})) AT TIME ZONE ${zone}) AND ${sql} <= ${now}`
      : `${sql} >= ${now} AND ${sql} < ((${today} + make_interval(${unit}=>${amount}) + interval '1 day') AT TIME ZONE ${zone})`;
  }
  throw caseListError('This field does not support this operator');
}

/** Compiles one condition; an unmatched row may yield NULL, so never negate the result. */
function predicate(condition: CaseCondition, context: CompileContext) {
  const field = Object.hasOwn(fields, condition.field)
    ? fields[condition.field]
    : undefined;
  if (!field) throw caseListError('This field cannot be filtered');
  if (condition.source)
    throw caseListError('This field has one value for all sources');
  const { op } = condition;
  const { kind, sql } = field;
  if (op === 'empty')
    return kind === 'tags' ? `cardinality(${sql})=0` : `${sql} IS NULL`;
  if (op === 'not_empty')
    return kind === 'tags' ? `cardinality(${sql})>0` : `${sql} IS NOT NULL`;
  if (kind === 'date') return datePredicate(sql, condition, context);
  const cast = kind === 'person' ? 'uuid[]' : 'text[]';
  const list = () =>
    context.parameters.bind(values(condition, kind, context.actorId), cast);
  if (kind === 'tags') {
    if (op === 'any_of') return `${sql} && ${list()}`;
    if (op === 'all_of') return `${sql} @> ${list()}`;
    if (op === 'none_of') return `NOT (${sql} && ${list()})`;
  } else {
    if (op === 'any_of') return `${sql} = ANY(${list()})`;
    if (op === 'none_of') return `(${sql} IS NULL OR ${sql} <> ALL(${list()}))`;
  }
  throw caseListError('This field does not support this operator');
}

/**
 * The list's filter over `l`: the view, the older single-value parameters, the conditions and
 * the search text. Binds every value after the query's fixed parameters.
 */
export function caseFilter(query: CaseQuery, context: CompileContext): string {
  const { parameters } = context;
  const parts = [
    query.view === 'needs_you'
      ? 'l.attention_reason IS NOT NULL'
      : query.view === 'history'
        ? "l.state='resolved'"
        : "l.state<>'resolved'",
  ];
  if (query.class)
    parts.push(`l.class=${parameters.bind(query.class, 'text')}`);
  if (query.severity)
    parts.push(`l.severity=${parameters.bind(query.severity, 'text')}`);
  if (query.state)
    parts.push(`l.state=${parameters.bind(query.state, 'text')}`);
  if (query.ownerId === 'unassigned') parts.push('l.owner_id IS NULL');
  else if (query.ownerId)
    parts.push(`l.owner_id=${parameters.bind(query.ownerId, 'uuid')}`);
  const conditions = query.where?.conditions ?? [];
  if (conditions.length)
    parts.push(
      `(${conditions
        .map((condition) => `(${predicate(condition, context)})`)
        .join(query.where?.match === 'any' ? ' OR ' : ' AND ')})`,
    );
  const q = query.q?.trim();
  if (q) {
    const pattern = parameters.bind(
      `%${q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`,
      'text',
    );
    parts.push(
      `(l.summary ILIKE ${pattern} OR l.subject_id ILIKE ${pattern} OR l.subject_kind ILIKE ${pattern})`,
    );
  }

  return parts.join(' AND ');
}

/** How one sort orders `l`: missing values last, then keys and ID in the sort direction. */
interface CaseSort {
  /** 1 when the row has no sort value. */
  missing: string;
  rank: string;
  at: string;
}

/** Sorts by a date; rows without one share the epoch as key and come last. */
const byDate = (sql: string): CaseSort => ({
  missing: `CASE WHEN ${sql} IS NULL THEN 1 ELSE 0 END`,
  rank: '0',
  at: `COALESCE(${sql},'epoch'::timestamptz)`,
});

const sorts: Readonly<Record<NonNullable<CaseQuery['sort']>, CaseSort>> = {
  // Today's order: severity, then the oldest attention request or, for issues that need
  // nobody, the oldest detection.
  urgency: { missing: '0', rank: 'l.rank', at: 'l.sort_at::timestamptz' },
  detected: byDate('l.detected_at'),
  lastActivity: byDate('l.last_activity'),
  waitingSince: byDate('l.waiting_since'),
};

/** The sort and direction a query asks for, with each sort's default direction. */
function caseOrdering(query: CaseQuery) {
  const sort = query.sort ?? 'urgency';

  return {
    sort,
    direction:
      query.direction ??
      (sort === 'detected' || sort === 'lastActivity' ? 'desc' : 'asc'),
  } as const;
}

/** Select-list columns `sort_missing`, `sort_rank` and `sort_key` for `l`. */
export function sortColumns(query: CaseQuery) {
  const sort = sorts[caseOrdering(query).sort];

  return `${sort.missing} AS sort_missing,${sort.rank} AS sort_rank,${sort.at} AS sort_key`;
}

/** `ORDER BY` terms over a relation with the sort columns. */
export function sortOrder(query: CaseQuery, alias: string) {
  const { direction } = caseOrdering(query);

  return `${alias}.sort_missing,${alias}.sort_rank ${direction},${alias}.sort_key ${direction},${alias}.id ${direction}`;
}

/** A page position in the list's sort. */
export interface CasePosition {
  missing: number;
  rank: number;
  at: string;
  id: string;
}

/** The rows of a sorted relation after `position`, or every row on the first page. */
export function afterPosition(
  query: CaseQuery,
  alias: string,
  position: CasePosition | undefined,
  parameters: CaseListParameters,
) {
  if (!position) return 'true';
  const op = caseOrdering(query).direction === 'desc' ? '<' : '>';
  const missing = parameters.bind(position.missing, 'integer');

  return `(${alias}.sort_missing>${missing} OR (${alias}.sort_missing=${missing} AND (${alias}.sort_rank,${alias}.sort_key,${alias}.id) ${op} (${parameters.bind(position.rank, 'integer')},${parameters.bind(position.at, 'timestamptz')},${parameters.bind(position.id, 'text')})))`;
}

/** The count of rows at or before `position`, the offset of the page after it. */
export function atOrBefore(
  query: CaseQuery,
  alias: string,
  position: CasePosition,
  parameters: CaseListParameters,
) {
  const op = caseOrdering(query).direction === 'desc' ? '>=' : '<=';
  const missing = parameters.bind(position.missing, 'integer');

  return `(${alias}.sort_missing<${missing} OR (${alias}.sort_missing=${missing} AND (${alias}.sort_rank,${alias}.sort_key,${alias}.id) ${op} (${parameters.bind(position.rank, 'integer')},${parameters.bind(position.at, 'timestamptz')},${parameters.bind(position.id, 'text')})))`;
}

/** How the list groups by one field: the group key of `l`, and the group order. */
interface CaseGroupField {
  /** Selects `key` once per group the row belongs to. */
  keys: string;
  /** Keys bind and compare as this type. */
  cast: 'text' | 'uuid';
  /** Orders groups after the empty one is put last. */
  order: (parameters: CaseListParameters) => string;
  /** Tests whether `l` belongs to the group with key `key`. */
  member: (key: string) => string;
  empty: string;
}

const optionOrder =
  (options: readonly string[]) => (parameters: CaseListParameters) =>
    `array_position(${parameters.bind(options, 'text[]')},g.key::text) NULLS LAST,g.key`;

const scalarGroup = (
  sql: string,
  order: CaseGroupField['order'],
  cast: CaseGroupField['cast'] = 'text',
): CaseGroupField => ({
  keys: `SELECT ${sql}${cast === 'uuid' ? '::text' : ''} AS key`,
  cast,
  order,
  member: (key) => `${sql}=${key}`,
  empty: `${sql} IS NULL`,
});

/** Classes and states in the issues catalog's option order, which groups follow. */
const classOrder = [
  'sync_failure',
  'stuck_fulfillment',
  'inventory_mismatch',
  'order_quantity_mismatch',
  'stock_sync_stall',
  'workflow_failure',
] as const satisfies readonly Incident['exceptionClass'][];

const stateOrder = [
  'detected',
  'diagnosed',
  'proposed',
  'awaiting_approval',
  'allowed',
  'executing',
  'verifying',
  'resolved',
  'failed',
  'escalated',
] as const satisfies readonly Incident['state'][];

/**
 * Group fields by catalog ID. Classes, states and severities follow the catalog's option order,
 * owners their names and sources their system keys. An issue with several sources belongs to
 * each source's group; the group without a value comes last.
 */
export function caseGroupFields(): Readonly<Record<string, CaseGroupField>> {
  return {
    class: scalarGroup('l.class', optionOrder(classOrder)),
    state: scalarGroup('l.state', optionOrder(stateOrder)),
    severity: scalarGroup('l.severity', optionOrder(['high', 'medium'])),
    owner: scalarGroup('l.owner_id', () => 'max(g.owner_name),g.key', 'uuid'),
    source: {
      keys: 'SELECT s AS key FROM unnest(l.sources) s UNION ALL SELECT NULL WHERE cardinality(l.sources)=0',
      cast: 'text',
      order: () => 'g.key',
      member: (key) => `${key}=ANY(l.sources)`,
      empty: 'cardinality(l.sources)=0',
    },
  };
}

/** Binds a group key from a request, refusing keys that cannot belong to the field. */
export function boundGroupKey(
  field: CaseGroupField,
  key: CaseGroupKey,
  parameters: CaseListParameters,
) {
  if (key === null) return null;
  if (typeof key !== 'string' || (field.cast === 'uuid' && !uuid.test(key)))
    throw caseListError('This group does not exist');

  return parameters.bind(key, field.cast);
}

const cursorSchema = z
  .object({
    context: z.string(),
    missing: z.number().int().min(0).max(1),
    rank: z.number().int().min(0).max(1),
    at: z.string().datetime({ offset: true }),
    id: z.string().uuid(),
  })
  .strict();

/**
 * The cursor scope of a query without its page position: the tenant, the reader (whom `me`
 * names), every filter, the search, sort and grouping. Within one group the scope adds the
 * group key and leaves out page sizes, so a group's first rows and later pages may differ.
 */
export function caseCursorContext(
  tenantId: string,
  actorId: string,
  query: CaseQuery,
  groupKey?: CaseGroupKey,
) {
  const ordering = caseOrdering(query);

  return createHash('sha256')
    .update(
      JSON.stringify([
        'cases-v2',
        tenantId,
        actorId,
        query.view,
        query.class ?? null,
        query.severity ?? null,
        query.state ?? null,
        query.ownerId ?? null,
        query.q?.trim() ?? '',
        query.where ?? null,
        query.group ?? null,
        query.timeZone ?? 'UTC',
        ordering.sort,
        ordering.direction,
        groupKey === undefined ? ['page', query.limit] : ['group', groupKey],
      ]),
    )
    .digest('hex');
}

/** Encodes a page position within `context`. */
export function encodeCaseCursor(context: string, position: CasePosition) {
  return Buffer.from(
    JSON.stringify({
      context,
      missing: position.missing,
      rank: position.rank,
      at: new Date(position.at).toISOString(),
      id: position.id,
    }),
  ).toString('base64url');
}

/** Decodes a cursor of the same query; anything else is a 400 error. */
export function decodeCaseCursor(cursor: string, context: string) {
  try {
    const parsed = cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString()),
    );
    if (parsed.context !== context) throw new Error('Cursor context mismatch');

    return parsed;
  } catch {
    throw Object.assign(new Error('Invalid cursor context'), {
      statusCode: 400,
    });
  }
}
