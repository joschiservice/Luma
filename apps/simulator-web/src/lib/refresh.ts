import type { QueryClient, QueryKey } from '@tanstack/react-query';

/**
 * Re-reads queries after a change committed. A read already in flight may have started before
 * the change, and invalidation alone does not restart a first load, so in-flight reads are
 * cancelled before the queries are invalidated.
 */
export async function refreshAfterChange(
  client: QueryClient,
  queryKeys: QueryKey[],
) {
  await Promise.all(
    queryKeys.map((queryKey) => client.cancelQueries({ queryKey })),
  );
  await Promise.all(
    queryKeys.map((queryKey) => client.invalidateQueries({ queryKey })),
  );
}
