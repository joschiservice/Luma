import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { CollectionSqlCast } from './collection/parameters.js';

/** PostgreSQL types a sort value is cast back to when a cursor is read. */
type ListKeyType = CollectionSqlCast;

/**
 * How one list orders its rows. `keys` are SQL expressions compared in order and `ids` the
 * unique row identity, compared last.
 *
 * `missing` says which rows have no sort value; they follow all others in both directions:
 * - omitted: rows whose first key is NULL. Later keys must be set exactly when the first is.
 * - `false`: every row has a value. The order then matches a plain index on the keys and ids.
 * - SQL condition: rows matching it. Every key must be non-NULL for all rows, so rows without
 *   a value still follow the keys among themselves.
 */
export interface ListOrder {
  keys: readonly { sql: string; type: ListKeyType }[];
  ids: readonly string[];
  direction: 'asc' | 'desc';
  missing?: string | false;
}

/** Position after the last row of a page. */
export interface ListPosition {
  /** 1 when the row has no sort value. Rows without one follow all others in both directions. */
  rank: 0 | 1;
  /** Sort values as PostgreSQL text; null when `rank` is 1 and the order has no `missing` keys. */
  keys: string[] | null;
  ids: string[];
}

const cursorSchema = z
  .object({
    context: z.string(),
    rank: z.union([z.literal(0), z.literal(1)]),
    keys: z.array(z.string().max(1024)).max(4).nullable(),
    ids: z.array(z.string().uuid()).min(1).max(3),
    asOf: z.string().datetime().optional(),
  })
  .strict();

/** Binds cursors to one list, the tenant and every filter and sort of the query. */
export function listScope(list: string, tenantId: string, scope: unknown) {
  return createHash('sha256')
    .update(JSON.stringify([list, tenantId, scope]))
    .digest('hex');
}

/** Encodes the position after `last`; `asOf` keeps the evaluation time of the first page. */
export function writeListCursor(
  context: string,
  last: ListPosition,
  asOf?: string,
) {
  return Buffer.from(
    JSON.stringify({ context, ...last, ...(asOf ? { asOf } : {}) }),
  ).toString('base64url');
}

/**
 * Decodes a cursor issued for the query identified by `context`. Throws a 400 error naming
 * `noun` when the cursor is malformed or belongs to other filters or sorting.
 */
export function readListCursor(
  value: string,
  context: string,
  noun: string,
): ListPosition & { asOf?: string } {
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error('Encoding');
    const cursor = cursorSchema.parse(JSON.parse(bytes.toString()));
    if (cursor.context !== context) throw new Error('Context');
    if (cursor.rank === 0 && cursor.keys === null) throw new Error('Rank');

    return {
      rank: cursor.rank,
      keys: cursor.keys,
      ids: cursor.ids,
      ...(cursor.asOf ? { asOf: cursor.asOf } : {}),
    };
  } catch {
    throw pageMismatch(noun);
  }
}

/** The 400 error for a page link that does not continue the current query. */
function pageMismatch(noun: string) {
  return Object.assign(
    new Error(
      `This page link no longer matches the ${noun} filters. Start from the first page.`,
    ),
    { statusCode: 400, expose: true },
  );
}

/**
 * Builds the ordering and keyset predicate of `order`. Parameters for `after` are appended to
 * `values`, so the returned SQL references them by position. Rows without a sort value come
 * last in both directions. Throws a 400 error when `after` does not fit the order.
 */
export function listKeyset(
  order: ListOrder,
  after: ListPosition | null,
  values: unknown[],
) {
  const direction = order.direction === 'asc' ? 'ASC' : 'DESC';
  const op = order.direction === 'asc' ? '>' : '<';
  const first = order.keys[0]!.sql;
  const parameter = (value: unknown, type: string) => {
    values.push(value);

    return `$${values.length}::${type}`;
  };
  const keyArray = `ARRAY[${order.keys.map((key) => `(${key.sql})::text`).join(',')}]`;
  const tuple = (after: ListPosition, ids: string[]) => {
    if (after.keys?.length !== order.keys.length) throw pageMismatch('list');
    const keys = order.keys.map((key, index) =>
      parameter(after.keys![index], key.type),
    );

    return `(${[...order.keys.map((key) => key.sql), ...order.ids].join(',')}) ${op} (${[...keys, ...ids].join(',')})`;
  };
  const ordered = (keys: readonly string[]) =>
    [...keys, ...order.ids.map((id) => `${id} ${direction}`)].join(',');
  const rest = order.keys.slice(1).map((key) => `${key.sql} ${direction}`);
  const cursorIds = (after: ListPosition) => {
    if (after.ids.length !== order.ids.length) throw pageMismatch('list');

    return after.ids.map((id) => parameter(id, 'uuid'));
  };

  if (order.missing === false) {
    if (after?.rank === 1) throw pageMismatch('list');

    return {
      predicate: after ? tuple(after, cursorIds(after)) : 'true',
      orderBy: ordered(order.keys.map((key) => `${key.sql} ${direction}`)),
      /** Selects the position columns `list_rank` and `list_keys` for `positionOf`. */
      position: `false AS list_rank,${keyArray} AS list_keys`,
    };
  }
  if (order.missing !== undefined) {
    const missing = `(${order.missing})`;
    let predicate = 'true';
    if (after) {
      const compared = tuple(after, cursorIds(after));
      predicate =
        after.rank === 1
          ? `(${missing} AND ${compared})`
          : `(${missing} OR ${compared})`;
    }

    return {
      predicate,
      orderBy: ordered([
        missing,
        ...order.keys.map((key) => `${key.sql} ${direction}`),
      ]),
      position: `${missing} AS list_rank,${keyArray} AS list_keys`,
    };
  }
  const missing = `((${first}) IS NULL)`;
  let predicate = 'true';
  if (after) {
    const ids = cursorIds(after);
    predicate =
      after.rank === 1
        ? `(${missing} AND (${order.ids.join(',')}) ${op} (${ids.join(',')}))`
        : `(${missing} OR ${tuple(after, ids)})`;
  }

  return {
    predicate,
    // NULLS LAST keeps rows without a value last in both directions.
    orderBy: ordered([`${first} ${direction} NULLS LAST`, ...rest]),
    position: `${missing} AS list_rank,CASE WHEN ${missing} THEN NULL ELSE ${keyArray} END AS list_keys`,
  };
}

/** Reads the position of a row selected with `listKeyset(...).position`. */
export function positionOf(
  row: { list_rank: boolean; list_keys: string[] | null },
  ids: string[],
): ListPosition {
  return { rank: row.list_rank ? 1 : 0, keys: row.list_keys, ids };
}
