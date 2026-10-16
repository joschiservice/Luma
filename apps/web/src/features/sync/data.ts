import {
  type AutoLinkInput,
  type AutoLinkPair,
  type IdentityDetail,
  type LinkInput,
  type SyncCommand,
  type SyncConnectionCommand,
  type SyncOverview,
  type SyncRecordState,
  syncRecordTypeSchema,
  type SyncStreamView,
} from '@luma/api-contract';
import {
  infiniteQueryOptions,
  queryOptions,
  skipToken,
} from '@tanstack/react-query';
import { z } from 'zod';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

const api = createWebApiClient();

type RunPage = Awaited<ReturnType<typeof api.sync.runs>>;

type RecordPage = Awaited<ReturnType<typeof api.sync.records>>;

/**
 * Data sync's address state: the sync open in the detail pane. Links that know a connection
 * and record type but not the sync, such as an issue about a failed read, name those instead;
 * Data sync opens the matching sync, or the connection's most urgent one without a type.
 */
export const syncSearch = z.object({
  stream: z.string().uuid().optional().catch(undefined),
  connection: z.string().uuid().optional().catch(undefined),
  type: syncRecordTypeSchema.optional().catch(undefined),
});

/** Query-key prefix for one workspace's sync status. */
export const syncKey = (organizationId: string) =>
  ['private', 'organization', organizationId, 'sync'] as const;

const busy = (stream: SyncStreamView) =>
  ['importing', 'syncing', 'retrying', 'waiting'].includes(stream.status);

/** Whether any sync is actively reading, so the view should refresh quickly. */
function syncBusy(overview: SyncOverview | undefined) {
  return !!overview?.connections.some((connection) =>
    connection.recordTypes.some(({ stream }) => stream && busy(stream)),
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

/**
 * Loads one sync's runs, newest first, a page at a time, or nothing while no sync is open.
 * Refreshes every few seconds while that sync reads, so a running run's counts move with its
 * progress, and every half minute otherwise.
 */
export const syncRunsOptions = (
  organizationId: string,
  stream: SyncStreamView | undefined,
) =>
  infiniteQueryOptions({
    ...privateQueryDefaults,
    queryKey: [...syncKey(organizationId), 'runs', stream?.id ?? null],
    refetchInterval: stream && busy(stream) ? 5000 : 30000,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: RunPage) => page.nextCursor ?? undefined,
    queryFn: stream
      ? ({ signal, pageParam }): Promise<RunPage> =>
          api.sync.runs(
            {
              params: { organizationId, streamId: stream.id },
              query: { before: pageParam },
            },
            { signal },
          )
      : skipToken,
  });

/** Loads one sync's records in a state, 25 at a time in source key order, or nothing. */
export const syncRecordsOptions = (
  organizationId: string,
  listed: { streamId: string; state: SyncRecordState } | null,
) =>
  infiniteQueryOptions({
    ...privateQueryDefaults,
    queryKey: [
      ...syncKey(organizationId),
      'records',
      listed?.streamId ?? null,
      listed?.state ?? null,
    ],
    refetchInterval: 30000,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: RecordPage) => page.nextCursor ?? undefined,
    queryFn: listed
      ? ({ signal, pageParam }): Promise<RecordPage> =>
          api.sync.records(
            {
              params: { organizationId, streamId: listed.streamId },
              query: { state: listed.state, cursor: pageParam },
            },
            { signal },
          )
      : skipToken,
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

/**
 * Pauses, resumes or retries every sync of one connection that the command changes, together,
 * and returns how many changed.
 */
export async function sendConnectionCommand(
  organizationId: string,
  connectionId: string,
  command: SyncConnectionCommand,
) {
  return api.sync.connectionCommand({
    params: { organizationId, connectionId },
    body: { command },
  });
}

/** Query-key prefix for one record's source identities. */
export const identityKey = (
  organizationId: string,
  kind: IdentityDetail['entity']['kind'],
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
 * Loads a record's source identities and reviewed link suggestions. Refreshes while
 * a link request is waiting or running.
 */
export const identityOptions = (
  organizationId: string,
  kind: IdentityDetail['entity']['kind'],
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
