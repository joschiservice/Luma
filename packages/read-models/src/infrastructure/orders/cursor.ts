import { z } from 'zod';

import type { CollectionGroupKey } from '../../application/collections.js';
import type { OrderListQuery } from '../../application/orders.js';
import {
  collectionCursorContext,
  type CollectionCursorPosition,
  readCollectionCursor,
} from '../collection/cursor.js';

export { writeCollectionCursor as writeCursor } from '../collection/cursor.js';

/** Binds cursors to the tenant and the exact filters, grouping and sort of one list query. */
export function cursorContext(tenantId: string, query: OrderListQuery) {
  const scope: Partial<OrderListQuery> = { ...query };
  delete scope.cursor;
  delete scope.count;
  if (scope.adaptive) {
    scope.adaptive = { ...scope.adaptive };
    delete scope.adaptive.offset;
  }

  return collectionCursorContext('orders-v3', tenantId, scope);
}

/**
 * Binds cursors within one group to the query and that group's key. Page sizes are left out,
 * so a group's first rows and its later pages may use different sizes.
 */
export function groupCursorContext(
  tenantId: string,
  query: OrderListQuery,
  key: CollectionGroupKey,
) {
  return cursorContext(tenantId, {
    ...query,
    groupKey: key,
    limit: 0,
    groupLimit: undefined,
  });
}

/**
 * Decodes a cursor for the list query identified by `context`. Throws a 400 error when the
 * cursor is malformed or was issued for other filters, grouping or sorting.
 */
export function readCursor(
  value: string,
  context: string,
): CollectionCursorPosition {
  return readCollectionCursor(
    value,
    context,
    'This page link no longer matches the order filters. Start from the first page.',
  );
}

/** Reads an offset cursor bound to the full tenant and saved-view predicate. */
export function readAdaptiveCursor(value: string, context: string): number {
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error('Encoding');
    const parsed = z
      .object({
        context: z.string(),
        offset: z.number().int().min(0).max(1000000),
      })
      .strict()
      .parse(JSON.parse(bytes.toString()));
    if (parsed.context !== context) throw new Error('Context');

    return parsed.offset;
  } catch {
    throw Object.assign(
      new Error(
        'The page link no longer matches this view. Start from the first page.',
      ),
      { statusCode: 400, expose: true },
    );
  }
}

/** Encodes the next native-query offset for the same saved-view predicate. */
export function writeAdaptiveCursor(context: string, offset: number): string {
  return Buffer.from(JSON.stringify({ context, offset })).toString('base64url');
}
