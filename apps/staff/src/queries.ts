import {
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
} from '@tanstack/react-query';

import { staffActivity } from './activity';
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

/** Reads workspace health under the support grant. Each read is audited, so it refreshes once a minute. */
export const healthOptions = (workspaceId: string, grantId: string) =>
  queryOptions({
    queryKey: ['staff', 'workspace', workspaceId, grantId, 'health'],
    queryFn: ({ signal }) => staffApi.health(workspaceId, grantId, signal),
    enabled: grantId.length > 0,
    retry: false,
    refetchInterval: 60_000,
  });

/** Pages access changes, newest first, under the support grant. Older pages load on request. */
export const accessHistoryOptions = (workspaceId: string, grantId: string) =>
  infiniteQueryOptions({
    queryKey: ['staff', 'workspace', workspaceId, grantId, 'access-history'],
    queryFn: ({ signal, pageParam }) =>
      staffApi.accessHistory(workspaceId, grantId, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: grantId.length > 0,
    retry: false,
  });

/** Cancels in-flight reads and erases all private data before changing staff identity. */
export async function clearPrivate(client: QueryClient) {
  await client.cancelQueries();
  client.clear();
  staffActivity.reset();
}

/** Identifies a session that can no longer authorize staff access. */
export function isAccessLoss(error: unknown) {
  return (
    error instanceof StaffApiError &&
    (error.status === 401 || error.status === 403)
  );
}
