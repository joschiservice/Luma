import {
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
} from '@tanstack/react-query';

import { staffActivity } from './activity';
import { createStaffApi, StaffApiError, staffApiForRegion } from './api';
import {
  canSearchStaffRegion,
  regionalFetch,
  staffRegion,
  staffRegions,
} from './regions';

/** Revalidates staff eligibility on navigation, focus and a bounded refresh interval. */
export const sessionOptions = (region = staffRegion()) => {
  const staffApi = staffApiForRegion(region);

  return queryOptions({
    queryKey: ['staff', 'session', region],
    queryFn: ({ signal }) => staffApi.session(signal),
    staleTime: 0,
    retry: false,
    refetchInterval: 30_000,
  });
};

/** Names and fetches a minimal directory search without retaining results across identities. */
export const directoryOptions = (query: string) => {
  const region = staffRegion();

  return queryOptions({
    queryKey: ['staff', 'directory', region, query],
    queryFn: ({ signal }) => searchRegionalDirectory(query, signal, region),
    enabled: query.length >= 3,
    retry: false,
  });
};

/** Reads workspace records under the specific support grant; failed grants are never retried. */
export const workspaceOptions = (workspaceId: string, grantId: string) => {
  const region = staffRegion();
  const staffApi = staffApiForRegion(region);

  return queryOptions({
    queryKey: ['staff', region, 'workspace', workspaceId, grantId],
    queryFn: ({ signal }) => staffApi.workspace(workspaceId, grantId, signal),
    enabled: grantId.length > 0,
    retry: false,
  });
};

/** Reads workspace health under the support grant. Each read is audited, so it refreshes once a minute. */
export const healthOptions = (workspaceId: string, grantId: string) => {
  const region = staffRegion();
  const staffApi = staffApiForRegion(region);

  return queryOptions({
    queryKey: ['staff', region, 'workspace', workspaceId, grantId, 'health'],
    queryFn: ({ signal }) => staffApi.health(workspaceId, grantId, signal),
    enabled: grantId.length > 0,
    retry: false,
    refetchInterval: 60_000,
  });
};

/** Pages access changes, newest first, under the support grant. Older pages load on request. */
export const accessHistoryOptions = (workspaceId: string, grantId: string) => {
  const region = staffRegion();
  const staffApi = staffApiForRegion(region);

  return infiniteQueryOptions({
    queryKey: [
      'staff',
      region,
      'workspace',
      workspaceId,
      grantId,
      'access-history',
    ],
    queryFn: ({ signal, pageParam }) =>
      staffApi.accessHistory(workspaceId, grantId, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: grantId.length > 0,
    retry: false,
  });
};

/** Reads one customer account under its account grant; failed grants are never retried. */
export const accountOptions = (userId: string, grantId: string) => {
  const region = staffRegion();
  const staffApi = staffApiForRegion(region);

  return queryOptions({
    queryKey: ['staff', region, 'account', userId, grantId],
    queryFn: ({ signal }) => staffApi.account(userId, grantId, signal),
    enabled: grantId.length > 0,
    retry: false,
  });
};

/** Staff audit filters as sent to the API; time bounds are ISO instants. */
export interface AuditFilters {
  staff?: string | undefined;
  workspace?: string | undefined;
  account?: string | undefined;
  event?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/** Pages the staff audit log, newest first. Every page read is itself audited, so it never polls. */
export const auditOptions = (filters: AuditFilters, enabled: boolean) => {
  const region = staffRegion();
  const staffApi = staffApiForRegion(region);

  return infiniteQueryOptions({
    queryKey: ['staff', region, 'audit', filters],
    queryFn: ({ signal, pageParam }) =>
      staffApi.audit(filters, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled,
    retry: false,
  });
};

/** Pages through an account's security events under its account grant, newest first. */
export const accountSecurityEventsOptions = (
  userId: string,
  grantId: string,
) => {
  const region = staffRegion();
  const staffApi = staffApiForRegion(region);

  return infiniteQueryOptions({
    queryKey: ['staff', region, 'account', userId, grantId, 'security-events'],
    queryFn: ({ pageParam, signal }) =>
      staffApi.accountSecurityEvents(userId, grantId, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: grantId.length > 0,
    retry: false,
  });
};

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

/** Searches all cells in parallel. An unavailable or out-of-scope cell always marks results incomplete. */
export async function searchRegionalDirectory(
  query: string,
  signal?: AbortSignal,
  searchRegion = staffRegion(),
) {
  const regions = await Promise.all(
    staffRegions().map(async (region) => {
      if (!canSearchStaffRegion(region, searchRegion))
        return {
          region,
          status: 'rollout-disabled' as const,
          directory: null,
          permissions: [],
        };
      try {
        const api = createStaffApi(
          regionalFetch(region),
          staffActivity,
          region,
        );
        const session = await api.session(signal);
        const directory = await api.directory(query, signal);

        return {
          region,
          status: 'answered' as const,
          directory,
          permissions: session.permissions,
        };
      } catch (error) {
        if (signal?.aborted) throw error;

        return {
          region,
          status:
            error instanceof StaffApiError &&
            (error.status === 401 || error.status === 403)
              ? ('access-required' as const)
              : ('unavailable' as const),
          directory: null,
          permissions: [],
        };
      }
    }),
  );

  return {
    regions,
    incomplete: regions.some((result) => result.status !== 'answered'),
    usersTruncated: regions.some((result) => result.directory?.usersTruncated),
    workspacesTruncated: regions.some(
      (result) => result.directory?.workspacesTruncated,
    ),
    users: regions.flatMap(
      (result) =>
        result.directory?.users.map((user) => ({
          ...user,
          region: result.region,
          permissions: result.permissions,
        })) ?? [],
    ),
    workspaces: regions.flatMap(
      (result) =>
        result.directory?.workspaces.map((workspace) => ({
          ...workspace,
          region: result.region,
          permissions: result.permissions,
        })) ?? [],
    ),
  };
}
