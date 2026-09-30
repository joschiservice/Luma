import {
  type IdentityDetail,
  identityDetailSchema,
  type LinkInput,
  linkRequestSchema,
  type SyncCommand,
  type SyncOverview,
  syncOverviewSchema,
  syncStreamSchema,
} from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { IdentityError } from '../identity/data';

const api = createWebApiClient();

/** Query-key prefix for one workspace's sync status. */
export const syncKey = (organizationId: string) =>
  ['private', 'organization', organizationId, 'sync'] as const;

/** Whether any sync is actively reading, so the view should refresh quickly. */
export function syncBusy(overview: SyncOverview | undefined) {
  return !!overview?.connections.some((connection) =>
    connection.recordTypes.some(
      ({ stream }) =>
        stream &&
        ['importing', 'syncing', 'retrying', 'waiting'].includes(stream.status),
    ),
  );
}

/**
 * Loads sync status for every connection. Refreshes every few seconds while an import or
 * sync is running and every half minute otherwise.
 */
export const syncOptions = (organizationId: string) =>
  queryOptions<SyncOverview, Error, SyncOverview, ReturnType<typeof syncKey>>({
    ...privateQueryDefaults,
    queryKey: syncKey(organizationId),
    refetchOnReconnect: 'always',
    refetchInterval: (query) => (syncBusy(query.state.data) ? 3000 : 30000),
    queryFn: async ({ signal }) => {
      const result = await api.sync.overview({
        params: { organizationId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200)
        throw new IdentityError(result.status, result.body);

      return syncOverviewSchema.parse(result.body);
    },
  });

/** Sends an operator command for one sync and returns its updated state. */
export async function sendSyncCommand(
  organizationId: string,
  streamId: string,
  command: SyncCommand,
) {
  const result = await api.sync.command({
    params: { organizationId, streamId },
    body: { command },
  });
  if (result.status !== 200)
    throw new IdentityError(result.status, result.body);

  return syncStreamSchema.parse(result.body);
}

/** Query-key prefix for the sources behind one SKU or location. */
export const identityKey = (
  organizationId: string,
  kind: 'sku' | 'location',
  entityId: string,
) =>
  [
    'private',
    'organization',
    organizationId,
    'identity',
    kind,
    entityId,
  ] as const;

/**
 * Loads the source records behind a SKU or location with link suggestions. Refreshes while
 * a link request is waiting or running.
 */
export const identityOptions = (
  organizationId: string,
  kind: 'sku' | 'location',
  entityId: string,
) =>
  queryOptions<
    IdentityDetail,
    Error,
    IdentityDetail,
    ReturnType<typeof identityKey>
  >({
    ...privateQueryDefaults,
    queryKey: identityKey(organizationId, kind, entityId),
    refetchInterval: (query) =>
      query.state.data?.requests.some((request) =>
        ['requested', 'running'].includes(request.state),
      )
        ? 1500
        : false,
    queryFn: async ({ signal }) => {
      const result = await api.sync.identity({
        params: { organizationId, kind, entityId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200)
        throw new IdentityError(result.status, result.body);

      return identityDetailSchema.parse(result.body);
    },
  });

/** Requests a link or unlink; Luma applies it in the background. */
export async function requestLink(organizationId: string, body: LinkInput) {
  const result = await api.sync.requestLink({
    params: { organizationId },
    body,
  });
  if (result.status !== 202)
    throw new IdentityError(result.status, result.body);

  return linkRequestSchema.parse(result.body);
}
