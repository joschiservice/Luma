import type {
  CollectionGroupKey,
  CollectionListParameters,
} from '../../application/collections.js';
import type {
  CollectionGroupFieldSql,
  CollectionGroupRequest,
} from './group.js';
import { collectionQueryError, SqlParameters } from './parameters.js';
import type { CollectionCompileContext } from './where.js';

/** Groups a grouped read returns at most; `groupsTruncated` says when more match. */
export const maxCollectionGroups = 50;

/**
 * The compile context for one list read: values bind after `values`, relative dates resolve
 * against `asOf` in `timeZone` (UTC by default). Throws a 400 error for an unknown time zone.
 */
export function collectionContext(
  values: unknown[],
  asOf: string,
  timeZone: string | undefined,
  userId: string,
): CollectionCompileContext {
  const zone = timeZone ?? 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
  } catch {
    throw collectionQueryError('Use an IANA time zone, such as Europe/Berlin.');
  }

  return {
    parameters: new SqlParameters(values),
    now: new Date(asOf),
    timeZone: zone,
    userId,
  };
}

/**
 * Resolves a list's grouping parameters against its group fields. `grouped` is true when the
 * read returns every group's first rows; with `groupKey` it pages within one group instead.
 * Throws a 400 error for an ungroupable field, a group key without a grouping, and a cursor
 * on a read of every group.
 */
export function collectionGrouping(
  query: CollectionListParameters & { cursor?: string | undefined },
  fields: Readonly<Record<string, CollectionGroupFieldSql>>,
): { request: CollectionGroupRequest | undefined; grouped: boolean } {
  if (query.groupKey !== undefined && !query.group)
    throw collectionQueryError('Choose a grouping to read one group.');
  const grouped = query.group !== undefined && query.groupKey === undefined;
  if (grouped && query.cursor)
    throw collectionQueryError(
      'Use a group’s page link together with its group key.',
    );
  if (!query.group) return { request: undefined, grouped };
  const field = Object.hasOwn(fields, query.group.field)
    ? fields[query.group.field]
    : undefined;
  if (!field) throw collectionQueryError('This field cannot be grouped');

  return {
    request: { field, granularity: query.group.granularity },
    grouped,
  };
}

/** Rows each group returns on a read of every group: 10 by default, 1 to 50. */
export function collectionGroupLimit(query: CollectionListParameters) {
  return Math.min(Math.max(query.groupLimit ?? 10, 1), 50);
}

/**
 * The cursor scope of a list query without its page position, so a cursor continues only the
 * query that issued it. Within one group the scope adds the group key and leaves out page
 * sizes, so a group's first rows and its later pages may use different sizes.
 */
export function collectionScope<T extends CollectionListParameters>(
  query: T & { cursor?: string | undefined; count?: string | undefined },
  key?: CollectionGroupKey,
) {
  // Cursor scopes hash without undefined properties, so clearing a property removes it.
  return {
    ...query,
    cursor: undefined,
    count: undefined,
    ...(key !== undefined
      ? { groupKey: key, limit: 0, groupLimit: undefined }
      : {}),
  };
}
