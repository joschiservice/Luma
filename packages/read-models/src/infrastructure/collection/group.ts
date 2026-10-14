import type {
  CollectionGranularity,
  CollectionGroupKey,
  CollectionGroupResult,
} from '../../application/collections.js';
import type { CollectionCursorPosition } from './cursor.js';
import { parseLocalDate, shiftLocalDate, startOfLocalDay } from './dates.js';
import {
  type CollectionOrdering,
  keysetCandidates,
  sortOrder,
} from './keyset.js';
import {
  collectionQueryError,
  type CollectionSqlCast,
  type SqlParameters,
} from './parameters.js';
import type { CollectionCompileContext } from './where.js';

/**
 * How a list groups by one field. SQL refers to the list row as `o`. Set exactly one of
 * `key`, `keys` or `date`. Rows without a value form the `null` group, which comes last.
 */
export interface CollectionGroupFieldSql {
  /** The row's single group value. */
  key?: string;
  /**
   * A subquery selecting a `key` column once per value of the row, for fields with several
   * values (such as every source of an order). A row counts in each of its values' groups.
   */
  keys?: string;
  /** A timestamptz expression grouped by local day, ISO week or month (`YYYY-MM-DD` keys). */
  date?: string;
  /** Type of `key` or `keys`; group keys from requests are checked and bound as this type. */
  cast: CollectionSqlCast;
  /** Group order: the catalog's option order, ascending keys, or true before false. */
  order: { options: readonly string[] } | 'asc' | 'true_first';
}

/** A money field summed per group and currency. */
export interface CollectionGroupSum {
  field: string;
  amount: string;
  currency: string;
}

/** A grouping request resolved against a field map entry. */
export interface CollectionGroupRequest {
  field: CollectionGroupFieldSql;
  granularity?: CollectionGranularity | undefined;
}

const units: Record<CollectionGranularity, string> = {
  day: 'day',
  week: 'week',
  month: 'month',
};

/** The lateral join that exposes `g.key` for each row of `o`. */
export function groupJoin(
  { field, granularity }: CollectionGroupRequest,
  context: CollectionCompileContext,
) {
  if (field.keys) return `LEFT JOIN LATERAL (${field.keys}) g ON true`;
  if (field.date) {
    if (!granularity)
      throw collectionQueryError('Date groups need a day, week or month');
    const zone = context.parameters.bind(context.timeZone, 'text');

    return `CROSS JOIN LATERAL (SELECT date_trunc('${units[granularity]}',${field.date} AT TIME ZONE ${zone})::date AS key) g`;
  }
  if (!field.key) throw new Error('Group field has no key');

  return `CROSS JOIN LATERAL (SELECT ${field.key} AS key) g`;
}

/** `ORDER BY` terms over `g.key` in the field's group order; the empty group comes last. */
export function groupOrder(
  field: CollectionGroupFieldSql,
  parameters: SqlParameters,
) {
  if (field.order === 'asc') return 'g.key IS NULL,g.key';
  if (field.order === 'true_first') return 'g.key IS NULL,g.key DESC';

  return `g.key IS NULL,array_position(${parameters.bind(field.order.options, 'text[]')},g.key::text) NULLS LAST,g.key::text`;
}

function boundKey(
  key: Exclude<CollectionGroupKey, null>,
  cast: CollectionSqlCast,
  parameters: SqlParameters,
) {
  const valid =
    cast === 'boolean'
      ? typeof key === 'boolean'
      : cast === 'numeric' || cast === 'integer'
        ? typeof key === 'number'
        : cast === 'uuid'
          ? typeof key === 'string' &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              key,
            )
          : typeof key === 'string';
  if (!valid) throw collectionQueryError('This group does not exist');

  return parameters.bind(key, cast);
}

/**
 * A predicate selecting the rows of one group, for paging within it with the list's normal
 * keyset. Date groups become an instant range so indexes on the date column apply. Throws a
 * 400 error when the key cannot belong to the field.
 */
export function groupMemberPredicate(
  request: CollectionGroupRequest,
  key: CollectionGroupKey,
  context: CollectionCompileContext,
) {
  const { field, granularity } = request;
  const { parameters, timeZone } = context;
  if (field.date) {
    if (key === null) return `${field.date} IS NULL`;
    const day = typeof key === 'string' ? parseLocalDate(key) : null;
    if (!day || !granularity)
      throw collectionQueryError('This group does not exist');
    const from = startOfLocalDay(day, timeZone).toISOString();
    const to = startOfLocalDay(
      shiftLocalDate(day, 1, granularity),
      timeZone,
    ).toISOString();

    return `${field.date} >= ${parameters.bind(from, 'timestamptz')} AND ${field.date} < ${parameters.bind(to, 'timestamptz')}`;
  }
  if (field.keys)
    return key === null
      ? `NOT EXISTS (${field.keys})`
      : `EXISTS (SELECT 1 FROM (${field.keys}) g WHERE g.key=${boundKey(key, field.cast, parameters)})`;
  if (!field.key) throw new Error('Group field has no key');

  return key === null
    ? `(${field.key}) IS NULL`
    : `(${field.key})=${boundKey(key, field.cast, parameters)}`;
}

/**
 * Predicates selecting the rows of the group `l.key` from SQL, for reading each group's
 * first rows: one for a value and one for the empty group. Both stay indexable because the
 * caller gates each by whether `l.key` is null.
 */
function memberOfListedGroup(
  { field, granularity }: CollectionGroupRequest,
  context: CollectionCompileContext,
) {
  if (field.date) {
    if (!granularity)
      throw collectionQueryError('Date groups need a day, week or month');
    const zone = context.parameters.bind(context.timeZone, 'text');

    return {
      value: `${field.date} >= (l.key::date::timestamp AT TIME ZONE ${zone}) AND ${field.date} < ((l.key::date + interval '1 ${units[granularity]}')::timestamp AT TIME ZONE ${zone})`,
      empty: `${field.date} IS NULL`,
    };
  }
  if (field.keys)
    return {
      value: `EXISTS (SELECT 1 FROM (${field.keys}) g WHERE g.key=l.key)`,
      empty: `NOT EXISTS (${field.keys})`,
    };
  if (!field.key) throw new Error('Group field has no key');

  return { value: `(${field.key})=l.key`, empty: `(${field.key}) IS NULL` };
}

/**
 * CTEs `group_totals`, `group_list` and `group_heads` over `relation` (aliased `o`): each
 * group's exact count from one aggregate pass, optional per-currency sums of one money
 * field, and each group's first `perGroup` rows in sort order with their cursor positions,
 * read by a bounded keyset seek per group. At most `maxGroups + 1` groups are kept so the
 * caller can report that more exist. Select the result with `groupsJson`.
 */
export function groupCtes(
  relation: string,
  request: CollectionGroupRequest,
  ordering: CollectionOrdering,
  perGroup: string,
  maxGroups: number,
  sum: CollectionGroupSum | undefined,
  context: CollectionCompileContext,
) {
  const field = sum ? context.parameters.bind(sum.field, 'text') : 'NULL::text';
  const member = memberOfListedGroup(request, context);
  // A date group is a bounded period, so its rows are read through the date predicate first
  // rather than by walking the sort order from its start for every group.
  const first = (gate: string, predicate: string) =>
    `(SELECT * FROM (${keysetCandidates(
      request.field.date
        ? `(SELECT * FROM ${relation} o WHERE ${gate} AND ${predicate} OFFSET 0)`
        : relation,
      ordering,
      perGroup,
      { rank: 'NULL::int', keys: 'NULL::text[]', id: 'NULL' },
      `${gate} AND ${predicate}`,
    )}) o ORDER BY ${sortOrder(ordering)} LIMIT ${perGroup})`;

  return `group_totals AS MATERIALIZED (
 SELECT g.key,${sum ? sum.currency : 'NULL::text'} AS currency,count(*)::int AS count,${sum ? `sum(${sum.amount})` : 'NULL::numeric'} AS amount
 FROM ${relation} o ${groupJoin(request, context)} GROUP BY 1,2
), group_list AS MATERIALIZED (
 SELECT g.key,row_number() OVER (ORDER BY ${groupOrder(request.field, context.parameters)}) AS group_position,g.count
 FROM (SELECT key,sum(count)::int AS count FROM group_totals GROUP BY key) g ORDER BY group_position LIMIT ${maxGroups + 1}
), group_heads AS MATERIALIZED (
 SELECT l.key,h.id,h.sort_rank,h.sort_keys,h.position FROM group_list l CROSS JOIN LATERAL (
  SELECT ${ordering.id} AS id,o.sort_rank,o.sort_keys,row_number() OVER (ORDER BY ${sortOrder(ordering)}) AS position
  FROM (${first('l.key IS NOT NULL', member.value)} UNION ALL ${first('l.key IS NULL', member.empty)}) o
 ) h
), group_sums AS MATERIALIZED (
 SELECT key,jsonb_agg(jsonb_build_object('field',${field},'currency',currency,'amount',amount::text) ORDER BY currency) AS sums
 FROM group_totals WHERE amount IS NOT NULL GROUP BY key
)`;
}

/** Selects the groups of `groupCtes` as one JSON array in group order. */
export const groupsJson = `COALESCE((SELECT jsonb_agg(jsonb_build_object('key',to_jsonb(l.key),'count',l.count,
 'head',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',h.id,'rank',h.sort_rank,'keys',h.sort_keys) ORDER BY h.position) FROM group_heads h WHERE h.key IS NOT DISTINCT FROM l.key),'[]'::jsonb),
 'sums',COALESCE((SELECT s.sums FROM group_sums s WHERE s.key IS NOT DISTINCT FROM l.key),'[]'::jsonb)) ORDER BY l.group_position)
 FROM group_list l),'[]'::jsonb)`;

/** Row IDs of every group's first rows, for loading the rows a grouped page shows. */
export const groupHeadIds = 'SELECT DISTINCT id FROM group_heads';

/** One group as `groupsJson` returns it. */
export interface CollectionGroupRow {
  key: CollectionGroupKey;
  count: number;
  head: { id: string; rank: 0 | 1; keys: (string | null)[] }[];
  sums: { field: string; currency: string | null; amount: string }[];
}

/**
 * Converts grouped rows into results: a group whose count exceeds its head gets a cursor for
 * the next rows within it. Returns at most `maxGroups` groups and whether more exist.
 */
export function groupResults(
  rows: CollectionGroupRow[],
  maxGroups: number,
  complete: boolean,
  cursor: (key: CollectionGroupKey, last: CollectionCursorPosition) => string,
): { groups: CollectionGroupResult[]; truncated: boolean } {
  return {
    groups: rows.slice(0, maxGroups).map((row) => {
      const last = row.head.at(-1);

      return {
        key: row.key,
        count: row.count,
        complete,
        itemIds: row.head.map((item) => item.id),
        nextCursor:
          last && row.count > row.head.length
            ? cursor(row.key, { rank: last.rank, keys: last.keys, id: last.id })
            : null,
        sums: row.sums,
      };
    }),
    truncated: rows.length > maxGroups,
  };
}
