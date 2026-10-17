import { invalid } from '@luma/platform';

/**
 * Where a metric's next page starts: after the record with sort `key`. `offset` counts the
 * records the reader has already paged past and only labels the page; membership is re-read.
 */
export interface MetricCursor {
  metric: string;
  offset: number;
  key: string[];
}

/** One page of a metric's cohort and the cursor for the page after it, if any. */
export interface MetricPage<Item> {
  offset: number;
  items: Item[];
  nextCursor: string | null;
}

/** Encodes an opaque cursor that only this API reads back. */
export function encodeMetricCursor(cursor: MetricCursor) {
  return Buffer.from(
    JSON.stringify([cursor.metric, cursor.offset, ...cursor.key]),
  ).toString('base64url');
}

/** Decodes a cursor this API issued; returns `undefined` for any other value. */
function decodeMetricCursor(value: string): MetricCursor | undefined {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (!Array.isArray(parsed) || parsed.length < 3) return undefined;
    const [metric, offset, ...key] = parsed as unknown[];
    if (
      typeof metric !== 'string' ||
      typeof offset !== 'number' ||
      !Number.isSafeInteger(offset) ||
      offset < 1 ||
      !key.every((part): part is string => typeof part === 'string')
    )
      return undefined;

    return { metric, offset, key };
  } catch {
    return undefined;
  }
}

/**
 * Reads a request's cursor for one of the requested `metrics`. `validKey` checks the sort key
 * a reader will bind. Any other value is rejected with a 422 validation error.
 */
export function readMetricCursor(
  value: string | undefined,
  metrics: readonly string[],
  validKey: (key: string[]) => boolean = () => true,
): MetricCursor | undefined {
  if (value === undefined) return undefined;
  const cursor = decodeMetricCursor(value);
  if (!cursor || !metrics.includes(cursor.metric) || !validKey(cursor.key))
    throw invalid(
      'This page cursor is not valid for this request. Start again from the first page.',
    );

  return cursor;
}

function compareKeys(a: readonly string[], b: readonly string[]) {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const order = a[index]!.localeCompare(b[index]!, 'en');
    if (order) return order;
  }

  return a.length - b.length;
}

/**
 * Sorts a cohort by `key` and returns the `limit` records after `after`. Records that joined or
 * left the cohort since the previous page don't shift later pages; a record whose sort key
 * changed may appear twice or not at all, so callers deduplicate by ID.
 */
export function pageCohort<Item>(
  items: readonly Item[],
  key: (item: Item) => string[],
  metric: string,
  limit: number,
  after?: MetricCursor,
): MetricPage<Item> {
  const sorted = items
    .map((item) => ({ item, key: key(item) }))
    .sort((a, b) => compareKeys(a.key, b.key));
  const start = after
    ? sorted.findIndex((entry) => compareKeys(entry.key, after.key) > 0)
    : 0;
  const rest = start < 0 ? [] : sorted.slice(start);
  const page = rest.slice(0, limit);
  const offset = after?.offset ?? 0;

  return {
    offset,
    items: page.map((entry) => entry.item),
    nextCursor:
      rest.length > limit
        ? encodeMetricCursor({
            metric,
            offset: offset + limit,
            key: page.at(-1)!.key,
          })
        : null,
  };
}
