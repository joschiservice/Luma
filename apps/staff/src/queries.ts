import { type QueryClient, queryOptions } from '@tanstack/react-query';

import { staffApi, StaffApiError } from './api';

/** Revalidates staff eligibility on navigation, focus and a bounded refresh interval. */
export const sessionOptions = () =>
  queryOptions({
    queryKey: ['staff', 'session'],
    queryFn: ({ signal }) => staffApi.session(signal),
    staleTime: 0,
    retry: false,
    refetchInterval: 30_000,
  });

/** Names and fetches a minimal directory search without retaining results across identities. */
export const directoryOptions = (query: string) =>
  queryOptions({
    queryKey: ['staff', 'directory', query],
    queryFn: ({ signal }) => staffApi.directory(query, signal),
    enabled: query.length >= 3,
    retry: false,
  });

/** Reads workspace records under the specific support grant; failed grants are never retried. */
export const workspaceOptions = (workspaceId: string, grantId: string) =>
  queryOptions({
    queryKey: ['staff', 'workspace', workspaceId, grantId],
    queryFn: ({ signal }) => staffApi.workspace(workspaceId, grantId, signal),
    enabled: grantId.length > 0,
    retry: false,
  });

/** Cancels in-flight reads and erases all private data before changing staff identity. */
export async function clearPrivate(client: QueryClient) {
  await client.cancelQueries();
  client.clear();
}

/** Identifies a session that can no longer authorize staff access. */
export function isAccessLoss(error: unknown) {
  return (
    error instanceof StaffApiError &&
    (error.status === 401 || error.status === 403)
  );
}
