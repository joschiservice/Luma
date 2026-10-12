import {
  decodeCursor,
  encodeCursor,
  type RecordQuery,
  type StoredRecord,
} from '@luma/simulator-core';
import { GraphQLError } from 'graphql';

import type { RequestContext } from './context.js';
import { all } from './records.js';

export type Args = Record<string, unknown>;

/** Reads an integer argument; GraphQL has already coerced its type. */
export function int(args: Args, name: string) {
  const value = args[name];

  return typeof value === 'number' ? value : null;
}

/** Reads a string or ID argument. */
export function text(args: Args, name: string) {
  const value = args[name];

  return typeof value === 'string' ? value : null;
}

/** Reads a list-of-strings argument. */
export function texts(args: Args, name: string) {
  const value = args[name];

  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : null;
}

/** A Shopify error for invalid arguments, reported in `errors` with partial data. */
export const argumentError = (message: string) =>
  new GraphQLError(message, { extensions: { code: 'BAD_REQUEST' } });

/** Wraps a store cursor so clients treat it as opaque, like Shopify's cursors. */
const wrap = (cursor: string) => Buffer.from(cursor).toString('base64url');

/** Unwraps and checks a client cursor for the given ordering. */
function unwrap(cursor: string | null, order: 'created' | 'updated') {
  if (cursor === null) return null;
  const value = Buffer.from(cursor, 'base64url').toString('utf8');
  try {
    decodeCursor(value, order);
  } catch {
    throw argumentError(`Invalid cursor for this connection: ${cursor}`);
  }

  return value;
}

/** Store query of a connection; paging fields come from the GraphQL arguments. */
export type ConnectionQuery = Omit<
  RecordQuery,
  'limit' | 'after' | 'offset' | 'reverse'
>;

export interface ConnectionOptions<T> {
  /**
   * The connection answers a `query` search, which Shopify serves from a search index that
   * lags behind writes; records changed within the context's index lag are not found.
   */
  search?: boolean;
  /** Residual filter the store cannot apply, such as free-text search. */
  match?: ((record: StoredRecord<T>) => boolean) | undefined;
}

/** Applies search-index lag to a store query. */
function indexed(
  context: RequestContext,
  query: ConnectionQuery,
  search: boolean | undefined,
): ConnectionQuery {
  const { now, indexLagMs } = context.shop;
  if (!search || indexLagMs <= 0) return query;
  // Records become searchable once they are `indexLagMs` old.
  const cutoff = now - indexLagMs + 1;

  return {
    ...query,
    updatedBefore: Math.min(query.updatedBefore ?? cutoff, cutoff),
  };
}

/**
 * Pages records as a Shopify connection with `first`/`after`, `last`/`before` and `reverse`.
 * Requires one of `first` or `last` with at most 250 items, as Shopify does.
 */
export async function connection<T>(
  context: RequestContext,
  args: Args,
  query: ConnectionQuery,
  options: ConnectionOptions<T> = {},
) {
  if (context.bulk) {
    const records = await all<T>(
      context.shop,
      indexed(context, query, options.search),
    );
    const nodes = options.match ? records.filter(options.match) : records;

    return {
      nodes,
      edges: nodes.map((node) => ({
        node,
        cursor: wrap(encodeCursor(node, query.order ?? 'created')),
      })),
      pageInfo: { hasNextPage: false, endCursor: null },
    };
  }
  const first = int(args, 'first');
  const last = int(args, 'last');
  if (first === null && last === null)
    throw argumentError('You must provide one of first or last.');
  if (first !== null && last !== null)
    throw argumentError('Passing both first and last is not supported.');
  const size = first ?? last ?? 0;
  if (size < 0 || size > 250)
    throw argumentError(
      `The page size must be between 0 and 250; ${size} was requested.`,
    );
  const order = query.order ?? 'created';
  const backwards = last !== null;
  const cursor = unwrap(text(args, backwards ? 'before' : 'after'), order);
  const filtered = {
    ...indexed(context, query, options.search),
    order,
    reverse: (args.reverse === true) !== backwards,
  };
  let items: StoredRecord<T>[] = [];
  let more = false;
  if (options.match) {
    const match = options.match;
    let after = cursor;
    scan: for (;;) {
      const page = await context.shop.store.page<T>({
        ...filtered,
        after,
        limit: 250,
      });
      for (const item of page.items)
        if (match(item)) {
          if (items.length === size) {
            more = true;
            break scan;
          }
          items.push(item);
        }
      if (!page.next) break;
      after = page.next;
    }
  } else {
    const page = await context.shop.store.page<T>({
      ...filtered,
      after: cursor,
      limit: size,
    });
    items = page.items;
    more = page.next !== null;
  }
  if (backwards) items.reverse();
  const end = items.at(-1);

  return {
    nodes: items,
    edges: items.map((node) => ({
      node,
      cursor: wrap(encodeCursor(node, order)),
    })),
    pageInfo: {
      hasNextPage: backwards ? cursor !== null : more,
      endCursor: end ? wrap(encodeCursor(end, order)) : null,
    },
  };
}

/** Counts records as Shopify's `*Count` fields do, capped at `limit` when one is given. */
export async function count<T>(
  context: RequestContext,
  args: Args,
  query: ConnectionQuery,
  options: ConnectionOptions<T> = {},
) {
  const filtered = indexed(context, query, options.search);
  const match = options.match;
  const total = match
    ? (await all<T>(context.shop, filtered)).filter(match).length
    : await context.shop.store.count(filtered);
  // GraphQL applies the schema default of 10,000; an explicit null counts everything.
  const limit = int(args, 'limit');

  return limit !== null && total > limit
    ? { count: limit, precision: 'AT_LEAST' }
    : { count: total, precision: 'EXACT' };
}

/** Reads an unpaginated Shopify list field, such as `Order.refunds`, optionally truncated. */
export async function list<T>(
  context: RequestContext,
  args: Args,
  query: ConnectionQuery,
) {
  const records = await all<T>(context.shop, query);
  const first = int(args, 'first');

  return first === null ? records : records.slice(0, first);
}

/**
 * Pages values that belong to one record, such as an order's shipping lines, as a Shopify
 * connection with `first` and `after`. Bulk exports list every value.
 */
export function valueConnection<T>(
  context: RequestContext,
  args: Args,
  values: T[],
) {
  const page = (items: T[], start: number, more: boolean) => ({
    nodes: items,
    edges: items.map((node, index) => ({
      node,
      cursor: wrap(`value:${start + index}`),
    })),
    pageInfo: {
      hasNextPage: more,
      endCursor: items.length
        ? wrap(`value:${start + items.length - 1}`)
        : null,
    },
  });
  if (context.bulk) return page(values, 0, false);
  const first = int(args, 'first');
  if (first === null || first < 0 || first > 250)
    throw argumentError('You must provide first, between 0 and 250.');
  const after = text(args, 'after');
  const position = after
    ? /^value:(\d+)$/.exec(Buffer.from(after, 'base64url').toString('utf8'))
    : null;
  if (after && !position)
    throw argumentError(`Invalid cursor for this connection: ${after}`);
  const start = position ? Number(position[1]) + 1 : 0;

  return page(
    values.slice(start, start + first),
    start,
    start + first < values.length,
  );
}
