import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { OrderListQuery } from '../../application/orders.js';

export interface OrderCursor {
  rank: number;
  key: string;
  id: string;
}

const cursorSchema = z
  .object({
    context: z.string(),
    rank: z.number().int().min(0).max(1),
    key: z.string().max(200),
    id: z.string().uuid(),
  })
  .strict();

/** Binds cursors to the tenant and the exact filters and sort of one list query. */
export function cursorContext(tenantId: string, query: OrderListQuery) {
  const scope: Partial<OrderListQuery> = { ...query };
  delete scope.cursor;
  delete scope.count;
  if (scope.adaptive) {
    scope.adaptive = { ...scope.adaptive };
    delete scope.adaptive.offset;
  }

  return createHash('sha256')
    .update(JSON.stringify(['orders-v2', tenantId, scope]))
    .digest('hex');
}

/** Encodes the position after `last` for the list query identified by `context`. */
export function writeCursor(context: string, last: OrderCursor) {
  return Buffer.from(
    JSON.stringify({ context, rank: last.rank, key: last.key, id: last.id }),
  ).toString('base64url');
}

/**
 * Decodes a cursor for the list query identified by `context`. Throws a 400 error when the
 * cursor is malformed or was issued for other filters or sorting.
 */
export function readCursor(value: string, context: string): OrderCursor {
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error('Encoding');
    const cursor = cursorSchema.parse(JSON.parse(bytes.toString()));
    if (cursor.context !== context) throw new Error('Context');

    return cursor;
  } catch {
    throw Object.assign(
      new Error(
        'This page link no longer matches the order filters. Start from the first page.',
      ),
      { statusCode: 400, expose: true },
    );
  }
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
