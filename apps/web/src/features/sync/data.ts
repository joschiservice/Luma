import type {
  AutoLinkInput,
  AutoLinkPair,
  IdentityDetail,
  LinkInput,
  SyncCommand,
  SyncOverview,
} from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

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
    queryFn: ({ signal }) =>
      api.sync.overview({ params: { organizationId } }, { signal }),
  });

/** Sends an operator command for one sync and returns its updated state. */
export async function sendSyncCommand(
  organizationId: string,
  streamId: string,
  command: SyncCommand,
) {
  return api.sync.command({
    params: { organizationId, streamId },
    body: { command },
  });
}

/** Query-key prefix for the sources behind one SKU or location. */
export const identityKey = (
  organizationId: string,
  kind: 'sku' | 'location' | 'order',
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
  kind: 'sku' | 'location' | 'order',
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
    queryFn: ({ signal }) =>
      api.sync.identity(
        { params: { organizationId, kind, entityId } },
        { signal },
      ),
  });

/** Requests a link or unlink; Luma applies it in the background. */
export async function requestLink(organizationId: string, body: LinkInput) {
  return api.sync.requestLink({ params: { organizationId }, body });
}

/** Loads automatic link rules and their latest outcomes. */
export const autoLinkOptions = (organizationId: string) =>
  queryOptions({
    ...privateQueryDefaults,
    queryKey: [...syncKey(organizationId), 'automatic-links'],
    refetchInterval: 15000,
    queryFn: ({ signal }) =>
      api.sync.autoLinkRules({ params: { organizationId } }, { signal }),
  });

/** Reads current matching evidence without linking records. */
export async function previewAutoLinks(
  organizationId: string,
  body: AutoLinkPair,
) {
  return api.sync.previewAutoLinks({ params: { organizationId }, body });
}

/** Saves a revision-checked rule; enabling continues with the caller's access. */
export async function saveAutoLinkRule(
  organizationId: string,
  body: AutoLinkInput,
) {
  return api.sync.saveAutoLinkRule({ params: { organizationId }, body });
}
