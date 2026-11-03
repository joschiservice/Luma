const canonicalUuid =
  "'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'";

/**
 * Builds SQL converting a trusted text expression to a uuid, NULL unless it is canonical text.
 * Compare a key column with this instead of casting the column to text, which keeps PostgreSQL
 * off the column's index. Malformed values match nothing instead of failing the statement.
 *
 * Under row-level security a join clause reading JSON never becomes an index condition, so it
 * scans the table per row. Convert first and join the plain value: `CROSS JOIN LATERAL (SELECT
 * sqlUuid(...) AS id OFFSET 0) key LEFT JOIN t ON t.id=key.id`, or a materialized CTE's column.
 * A scalar subquery or `LATERAL (… LIMIT 1)` also works, unless the text reads a column from an
 * earlier outer join. Confirm with `EXPLAIN` as a runtime role.
 */
export function sqlUuid(text: string): string {
  return `CASE WHEN ${text} ~ ${canonicalUuid} THEN (${text})::uuid END`;
}

/**
 * Builds SQL converting a trusted `text[]` expression to a `uuid[]`, dropping malformed values,
 * for comparing a key column with `= ANY(...)`.
 */
export function sqlUuids(textArray: string): string {
  return `ARRAY(SELECT ${sqlUuid('value')} FROM unnest(${textArray}) value)`;
}
