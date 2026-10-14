import type { CollectionSqlCast } from './parameters.js';

/**
 * How a list sorts by one field. SQL refers to the list row as `o`. Rows without a value come
 * after all others in both directions; ties break by the row ID in the sort direction.
 *
 * Keys compare as a tuple in the sort direction, so a multi-key sort (such as currency, then
 * amount) uses one direction for every key. Keys must be null or constant on rows without a
 * value: those rows page by ID alone, and their seek orders by the keys too so the same index
 * serves it. Key text must stay under 200 characters to fit in a cursor; cap long text keys
 * in the expression.
 */
export interface CollectionSortSql {
  /** True when the row has a sort value. Write it so an index on the keys can serve it. */
  present: string;
  /** True when the row has no sort value: the complement of `present`; `false` if never. */
  missing: string;
  keys: readonly { sql: string; cast: CollectionSqlCast }[];
}

/** Bound cursor placeholders: rank (`integer`), keys (`text[]`) and row ID, each null on page one. */
export interface CollectionCursorParameters {
  rank: string;
  keys: string;
  id: string;
}

/** Options shared by the keyset helpers. `id` is the unique row ID column of `o`. */
export interface CollectionOrdering {
  sort: CollectionSortSql;
  direction: 'asc' | 'desc';
  id: string;
}

const tuple = (values: readonly string[]) =>
  values.length === 1 ? values[0]! : `(${values.join(',')})`;

/** `ORDER BY` terms that put missing values last, then keys and ID in the sort direction. */
export function sortOrder({ sort, direction, id }: CollectionOrdering) {
  // PostgreSQL rejects constant ORDER BY terms; a sort that is never missing needs no rank.
  return [
    ...(sort.missing === 'false' ? [] : [`(${sort.missing})`]),
    ...sort.keys.map((key) => `${key.sql} ${direction}`),
    `${id} ${direction}`,
  ].join(',');
}

/** Select-list columns `sort_rank` (0 or 1) and `sort_keys` (text[]) for writing cursors. */
export function sortColumns({ sort }: Pick<CollectionOrdering, 'sort'>) {
  return `CASE WHEN ${sort.present} THEN 0 ELSE 1 END AS sort_rank,ARRAY[${sort.keys.map((key) => `(${key.sql})::text`).join(',')}]::text[] AS sort_keys`;
}

/**
 * Selects the rows after a cursor, up to `limit` rows, from `relation` (aliased `o`) plus the
 * `sort_rank` and `sort_keys` columns. Rows with and without a value are read by two bounded
 * seeks so an index on (present keys, ID) serves both directions. `where` narrows the rows.
 * The caller orders the result with `sortOrder` over the same alias and applies the final
 * limit.
 */
export function keysetCandidates(
  relation: string,
  ordering: CollectionOrdering,
  limit: string,
  cursor: CollectionCursorParameters,
  where = 'true',
) {
  const { sort, direction, id } = ordering;
  const op = direction === 'desc' ? '<' : '>';
  const keys = sort.keys.map((key) => key.sql);
  const bounds = sort.keys.map(
    (key, index) => `(${cursor.keys})[${index + 1}]::${key.cast}`,
  );
  const columns = `o.*,${sortColumns(ordering)}`;

  return `(SELECT ${columns} FROM ${relation} o WHERE ${where} AND ${sort.present} AND (${cursor.rank} IS NULL OR
    (${cursor.rank}=0 AND ${tuple([...keys, id])} ${op} ${tuple([...bounds, cursor.id])}))
   ORDER BY ${[...keys, id].map((key) => `${key} ${direction}`).join(',')} LIMIT ${limit})
  UNION ALL
  (SELECT ${columns} FROM ${relation} o WHERE ${where} AND ${sort.missing} AND (${cursor.rank} IS NULL OR ${cursor.rank}=0 OR
    (${cursor.rank}=1 AND ${id} ${op} ${cursor.id}))
   ORDER BY ${[...keys, id].map((key) => `${key} ${direction}`).join(',')} LIMIT ${limit})`;
}
