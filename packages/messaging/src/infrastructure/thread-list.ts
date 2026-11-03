import { sqlUuid } from '@luma/platform';

import type {
  ThreadCondition,
  ThreadFilter,
  ThreadPosition,
} from '../application/store.js';

// Compiles the inbox's conditions, sort and grouping into bound SQL over `messaging_threads t`.
// Every field is a structured thread property: message text and subjects are never filtered.
// Field SQL comes only from this file; every request value is bound as a parameter.

/** A 400 error whose message is shown to the person who made the request. */
export function threadListError(message: string) {
  return Object.assign(new Error(message), { statusCode: 400, expose: true });
}

/** Appends values to a query's parameters and returns typed placeholders. */
export class ThreadListParameters {
  constructor(readonly values: unknown[]) {}

  bind(value: unknown, cast: string) {
    this.values.push(value);

    return `$${this.values.length}::${cast}`;
  }
}

const activeLinks =
  "SELECT 1 FROM messaging_links l WHERE l.tenant_id=t.tenant_id AND l.thread_id=t.id AND l.state='active'";

/** Facts waiting for review, as the `review` view counts them. */
export const factsToReview =
  "EXISTS (SELECT 1 FROM messaging_facts f JOIN messaging_documents d ON d.tenant_id=f.tenant_id AND d.id=f.document_id WHERE f.tenant_id=t.tenant_id AND d.thread_id=t.id AND f.status IN ('proposed','needs_correction'))";

type Field =
  | { kind: 'choice'; sql: string; cast: 'text' | 'uuid' }
  | { kind: 'date'; sql: string }
  | { kind: 'flag'; sql: string }
  | { kind: 'links' };

const fields: Readonly<Record<string, Field>> = {
  owner: { kind: 'choice', sql: 't.owner_id', cast: 'text' },
  status: { kind: 'choice', sql: 't.status', cast: 'text' },
  mailbox: { kind: 'choice', sql: 't.connection_id', cast: 'uuid' },
  due: { kind: 'date', sql: 't.reply_due_at' },
  activity: { kind: 'date', sql: 't.last_message_at' },
  linkedRecord: { kind: 'links' },
  hasAttachments: {
    kind: 'flag',
    sql: "COALESCE((t.document->>'attachmentCount')::integer,0)>0",
  },
  // An inbound message newer than the latest reply, as the list shows it.
  awaitingReply: {
    kind: 'flag',
    sql: '(t.last_inbound_at IS NOT NULL AND (t.last_outbound_at IS NULL OR t.last_inbound_at>t.last_outbound_at))',
  },
  factsToReview: { kind: 'flag', sql: factsToReview },
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const day = /^\d{4}-\d{2}-\d{2}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What conditions resolve against. `zone` is bound on first use. */
interface Context {
  parameters: ThreadListParameters;
  now: string;
  zone: () => string;
  actorId: string;
}

/** The condition's values, with `me` resolved to the reader. */
function values(condition: ThreadCondition, cast: string, actorId: string) {
  if (!Array.isArray(condition.value) || !condition.value.length)
    throw threadListError('This operator needs a list of values');
  const resolved: unknown[] = condition.value.map((value: unknown) =>
    isObject(value) && value.dynamic === 'me' ? actorId : value,
  );
  if (
    !resolved.every(
      (value): value is string =>
        typeof value === 'string' && (cast !== 'uuid' || uuid.test(value)),
    )
  )
    throw threadListError(
      cast === 'uuid' ? 'This value is not a valid record ID' : 'Expected text',
    );

  return [...new Set(resolved)];
}

/** A date bound: the start and end of a local day, or an exact instant. */
function moment(value: unknown, context: Context) {
  const { parameters, now } = context;
  if (isObject(value) && value.dynamic === 'today') {
    const zone = context.zone();
    const today = `(${now} AT TIME ZONE ${zone})::date`;

    return {
      start: `(${today}::timestamp AT TIME ZONE ${zone})`,
      end: `((${today}+1)::timestamp AT TIME ZONE ${zone})`,
      instant: false,
    };
  }
  if (typeof value === 'string' && day.test(value)) {
    const zone = context.zone();
    const bound = parameters.bind(value, 'date');

    return {
      start: `(${bound}::timestamp AT TIME ZONE ${zone})`,
      end: `((${bound}+1)::timestamp AT TIME ZONE ${zone})`,
      instant: false,
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
  throw threadListError(
    'Dates need a day (YYYY-MM-DD), a time with an offset or today',
  );
}

const intervals = { day: 'days', week: 'weeks', month: 'months' } as const;

function datePredicate(
  sql: string,
  condition: ThreadCondition,
  context: Context,
) {
  const { op, value } = condition;
  const { parameters, now } = context;
  if (op === 'before') return `${sql} < ${moment(value, context).start}`;
  if (op === 'after') {
    const bound = moment(value, context);

    return `${sql} ${bound.instant ? '>' : '>='} ${bound.end}`;
  }
  if (op === 'between') {
    if (!isObject(value) || !('from' in value) || !('to' in value))
      throw threadListError('A range needs a start or an end');
    const parts: string[] = [];
    if (value.from !== null)
      parts.push(`${sql} >= ${moment(value.from, context).start}`);
    if (value.to !== null) {
      const bound = moment(value.to, context);
      parts.push(`${sql} ${bound.instant ? '<=' : '<'} ${bound.end}`);
    }
    if (!parts.length) throw threadListError('A range needs a start or an end');

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
      throw threadListError('A relative period needs an amount and unit');
    const unit = intervals[value.unit as keyof typeof intervals];
    const amount = parameters.bind(value.amount, 'integer');
    const zone = context.zone();
    const today = `(${now} AT TIME ZONE ${zone})::date::timestamp`;

    return op === 'within_last'
      ? `${sql} >= ((${today} - make_interval(${unit}=>${amount})) AT TIME ZONE ${zone}) AND ${sql} <= ${now}`
      : `${sql} >= ${now} AND ${sql} < ((${today} + make_interval(${unit}=>${amount}) + interval '1 day') AT TIME ZONE ${zone})`;
  }
  throw threadListError('This field does not support this operator');
}

/** Compiles one condition over `t`; an unmatched row may yield NULL, so never negate it. */
function predicate(condition: ThreadCondition, context: Context) {
  const field = Object.hasOwn(fields, condition.field)
    ? fields[condition.field]
    : undefined;
  if (!field) throw threadListError('This field cannot be filtered');
  if (condition.source)
    throw threadListError('This field has one value for all sources');
  const { op } = condition;
  const { parameters, actorId } = context;
  if (field.kind === 'flag') {
    if (op !== 'is' || typeof condition.value !== 'boolean')
      throw threadListError('Expected true or false');

    return condition.value ? field.sql : `NOT ${field.sql}`;
  }
  if (field.kind === 'links') {
    if (op === 'empty') return `NOT EXISTS (${activeLinks})`;
    if (op === 'not_empty') return `EXISTS (${activeLinks})`;
    const kinds = () =>
      parameters.bind(values(condition, 'text', actorId), 'text[]');
    if (op === 'any_of')
      return `EXISTS (${activeLinks} AND l.record_kind=ANY(${kinds()}))`;
    if (op === 'none_of')
      return `NOT EXISTS (${activeLinks} AND l.record_kind=ANY(${kinds()}))`;
    if (op === 'all_of')
      return `(SELECT count(DISTINCT l.record_kind) FROM messaging_links l WHERE l.tenant_id=t.tenant_id AND l.thread_id=t.id AND l.state='active' AND l.record_kind=ANY(${kinds()}))=${parameters.bind(values(condition, 'text', actorId).length, 'integer')}`;
    throw threadListError('This field does not support this operator');
  }
  if (op === 'empty') return `${field.sql} IS NULL`;
  if (op === 'not_empty') return `${field.sql} IS NOT NULL`;
  if (field.kind === 'date')
    return datePredicate(field.sql, condition, context);
  const list = () =>
    parameters.bind(values(condition, field.cast, actorId), `${field.cast}[]`);
  if (op === 'any_of') return `${field.sql} = ANY(${list()})`;
  if (op === 'none_of')
    return `(${field.sql} IS NULL OR ${field.sql} <> ALL(${list()}))`;
  throw threadListError('This field does not support this operator');
}

/** The conditions as one predicate over `t`, or `true` without conditions. */
export function threadConditions(
  filter: Pick<ThreadFilter, 'where' | 'actorId'>,
  context: Omit<Context, 'actorId'>,
) {
  const conditions = filter.where?.conditions ?? [];
  if (!conditions.length) return 'true';

  return `(${conditions
    .map(
      (condition) =>
        `(${predicate(condition, { ...context, actorId: filter.actorId })})`,
    )
    .join(filter.where?.match === 'any' ? ' OR ' : ' AND ')})`;
}

/** How each sort orders `t`; threads without a deadline come last for `due`. */
const sorts = {
  activity: { missing: null, key: 't.last_message_at' },
  due: {
    missing: '(t.reply_due_at IS NULL)',
    key: "COALESCE(t.reply_due_at,'epoch'::timestamptz)",
  },
} as const;

/** The sort and direction of a filter: newest activity, or the earliest deadline. */
function threadOrdering(filter: Pick<ThreadFilter, 'sort' | 'direction'>) {
  const sort = filter.sort ?? 'activity';

  return {
    sort,
    direction: filter.direction ?? (sort === 'activity' ? 'desc' : 'asc'),
  } as const;
}

/** `ORDER BY` terms: missing values last, then the key and ID in the sort direction. */
export function threadOrder(filter: Pick<ThreadFilter, 'sort' | 'direction'>) {
  const { sort, direction } = threadOrdering(filter);
  const { missing, key } = sorts[sort];

  return [
    ...(missing ? [missing] : []),
    `${key} ${direction}`,
    `t.id ${direction}`,
  ].join(',');
}

/** The threads after a page position in the filter's sort. */
export function threadAfter(
  filter: Pick<ThreadFilter, 'sort' | 'direction'>,
  position: ThreadPosition | undefined,
  parameters: ThreadListParameters,
) {
  if (!position) return 'true';
  const { sort, direction } = threadOrdering(filter);
  const { missing, key } = sorts[sort];
  const op = direction === 'desc' ? '<' : '>';
  const tuple = `(${key},t.id) ${op} (${parameters.bind(position.at, 'timestamptz')},${parameters.bind(position.id, 'uuid')})`;
  if (!missing) return tuple;
  const flag = parameters.bind(position.missing === 1, 'boolean');

  return `(${missing} > ${flag} OR (${missing} = ${flag} AND ${tuple}))`;
}

/** How the inbox groups threads by one field. */
interface GroupField {
  key: string;
  cast: 'text' | 'uuid';
  /** Orders groups after the empty one is put last; `g.key` is the group's key. */
  order: (parameters: ThreadListParameters) => string;
}

const groupFields: Readonly<Record<string, GroupField>> = {
  owner: { key: 't.owner_id', cast: 'text', order: () => 'g.key' },
  status: {
    key: 't.status',
    cast: 'text',
    order: (parameters) =>
      `array_position(${parameters.bind(['open', 'waiting', 'closed'], 'text[]')},g.key) NULLS LAST,g.key`,
  },
  // Mailboxes order by their label.
  mailbox: {
    key: 't.connection_id::text',
    cast: 'uuid',
    order: () =>
      `(SELECT m.document->>'label' FROM messaging_mailboxes m WHERE m.tenant_id=$1 AND m.connection_id=${sqlUuid('g.key')}),g.key`,
  },
};

/** The group field of a catalog field, or a 400 error. */
export function threadGroupField(field: string) {
  const group = Object.hasOwn(groupFields, field)
    ? groupFields[field]
    : undefined;
  if (!group) throw threadListError('This field cannot be grouped');

  return group;
}

/** The predicate selecting one group's threads. */
export function threadGroupMember(
  member: NonNullable<ThreadFilter['member']>,
  parameters: ThreadListParameters,
) {
  const field = threadGroupField(member.field);
  if (member.key === null) return `${field.key} IS NULL`;
  if (field.cast === 'uuid' && !uuid.test(member.key))
    throw threadListError('This group does not exist');

  return `${field.key}=${parameters.bind(member.key, 'text')}`;
}
