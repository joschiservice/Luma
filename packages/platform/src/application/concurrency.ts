/**
 * Maps items with at most `limit` calls in flight and returns results in input order. Use it
 * where one request would otherwise open many database transactions at once and starve the
 * shared pool. Like `Promise.all`, it rejects with the first failure; calls already running
 * finish, but no new ones start.
 */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError('limit must be a positive integer');
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const run = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await map(items[index] as T, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));

  return results;
}

/**
 * Like `Promise.allSettled` over `map`, with at most `limit` calls in flight. Every item runs;
 * results keep input order.
 */
export function settleLimited<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  return mapLimited(items, limit, async (item, index) => {
    try {
      return { status: 'fulfilled', value: await map(item, index) } as const;
    } catch (reason) {
      return { status: 'rejected', reason } as const;
    }
  });
}
