import { createHash } from 'node:crypto';

import { z } from 'zod';

import { collectionQueryError } from './parameters.js';

/** The position after the last row of a page, in `CollectionSortSql` terms. */
export interface CollectionCursorPosition {
  rank: 0 | 1;
  keys: (string | null)[];
  id: string;
}

const positionSchema = z
  .object({
    context: z.string().regex(/^[0-9a-f]{64}$/),
    rank: z.union([z.literal(0), z.literal(1)]),
    keys: z.array(z.string().max(200).nullable()).max(4),
    id: z.string().min(1).max(64),
    asOf: z.string().datetime().optional(),
  })
  .strict();

/** JSON with object keys in sorted order, so equal scopes hash equally. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== 'object' || value === null) return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, canonical(item)]),
  );
}

const relativeOperators = new Set(['within_last', 'within_next']);

function usesRelativeDays(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(usesRelativeDays);
  if (typeof value !== 'object' || value === null) return false;
  if ('dynamic' in value && value.dynamic === 'today') return true;
  if (
    'op' in value &&
    typeof value.op === 'string' &&
    relativeOperators.has(value.op)
  )
    return true;

  return Object.values(value).some(usesRelativeDays);
}

/** The reader's calendar day in a time zone, as YYYY-MM-DD. */
function localDay(now: Date, timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Hashes the tenant and every parameter that decides which rows match and in which order, so
 * a cursor only continues the query that issued it. Property order and undefined properties
 * do not matter. `namespace` versions the cursor format. Conditions relative to today also
 * bind the reader's current day, so after midnight a page link starts again from the first
 * page instead of continuing a different set of rows.
 */
export function collectionCursorContext(
  namespace: string,
  tenantId: string,
  scope: unknown,
  now: Date = new Date(),
) {
  const where =
    typeof scope === 'object' && scope !== null && 'where' in scope
      ? scope.where
      : undefined;
  const zone =
    typeof scope === 'object' &&
    scope !== null &&
    'timeZone' in scope &&
    typeof scope.timeZone === 'string'
      ? scope.timeZone
      : 'UTC';
  let day: string | undefined;
  if (usesRelativeDays(where)) {
    try {
      day = localDay(now, zone);
    } catch {
      day = localDay(now, 'UTC');
    }
  }

  return createHash('sha256')
    .update(
      JSON.stringify([
        namespace,
        tenantId,
        canonical(scope),
        ...(day ? [day] : []),
      ]),
    )
    .digest('hex');
}

/**
 * Encodes the position after `last` for the query identified by `context`. `asOf` keeps the
 * first page's evaluation time for lists whose matches depend on the read clock.
 */
export function writeCollectionCursor(
  context: string,
  last: CollectionCursorPosition,
  asOf?: string,
) {
  return Buffer.from(
    JSON.stringify({
      context,
      rank: last.rank,
      keys: last.keys,
      id: last.id,
      ...(asOf ? { asOf } : {}),
    }),
  ).toString('base64url');
}

/**
 * Decodes a cursor for the query identified by `context`, with the evaluation time it carries.
 * Throws a 400 error with `message` when the cursor is malformed or was issued for other
 * filters, grouping or sorting.
 */
export function readCollectionCursor(
  value: string,
  context: string,
  message: string,
): CollectionCursorPosition & { asOf?: string } {
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error('Encoding');
    const cursor = positionSchema.parse(JSON.parse(bytes.toString()));
    if (cursor.context !== context) throw new Error('Context');

    return {
      rank: cursor.rank,
      keys: cursor.keys,
      id: cursor.id,
      ...(cursor.asOf ? { asOf: cursor.asOf } : {}),
    };
  } catch {
    throw collectionQueryError(message);
  }
}
