import type { ConnectionManagement } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { hasPermission, requirePermission } from '@luma/identity';
import {
  conflict,
  invalid,
  notFound,
  ServiceError,
  unavailable,
} from '@luma/platform';

import {
  historyWindow,
  recordCapabilities,
  recordTypes,
  streamStatus,
  type SyncStream,
} from '../domain/streams.js';
import { syncWait } from '../domain/waiting.js';
import type { AutoLinkService } from './automatic-links.js';
import type {
  ConnectionCommand,
  ItemKey,
  LinkRequest,
  RecordState,
  StreamCommand,
  StreamCoverage,
  SyncRecordProblem,
  SyncRun,
  SyncStore,
} from './ports.js';
import type {
  IdentityDetail,
  LinkInput,
  LinkRequestView,
  SyncConnectionView,
  SyncOverview,
  SyncRecordView,
  SyncRunView,
  SyncStreamView,
} from './views.js';

/** Reads a canonical record's sources and suggestions for a person to review. */
export type IdentityReader = (
  tenantId: string,
  kind: 'sku' | 'location' | 'order' | 'order_line',
  entityId: string,
) => Promise<Omit<IdentityDetail, 'requests' | 'canManage'> | null>;

export interface SyncServiceDependencies {
  store: SyncStore;
  automaticLinks?: AutoLinkService;
  connections: Pick<ConnectionManagement, 'list'>;
  identities: IdentityReader;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  /** Sources withheld by a release gate or anchored to an owner record. */
  sourcePolicy?(
    context: TenantContext,
  ): Promise<{ hidden: string[]; fixed: string[] }>;
  now?: () => Date;
  id?: () => string;
}

const manage = (context: TenantContext) =>
  hasPermission(context, 'sync.manage');

/** Runs per page of one stream's history. */
const streamRunLimit = 20;

/** Records per page of one stream's record list. */
const recordPageSize = 25;

/** Encodes a record's source key as an opaque page cursor. */
const recordCursor = (item: Record<keyof ItemKey, string>) =>
  Buffer.from(
    JSON.stringify([item.resource, item.scopeKey, item.externalId]),
  ).toString('base64url');

function readRecordCursor(cursor: string): Record<keyof ItemKey, string> {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      value.every((part): part is string => typeof part === 'string')
    ) {
      const [resource = '', scopeKey = '', externalId = ''] = value;

      return { resource, scopeKey, externalId };
    }
  } catch {
    // Reported below like any other unreadable cursor.
  }
  throw invalid(
    'This page link is no longer valid. Start from the first page.',
  );
}

const recordView = (record: SyncRecordProblem): SyncRecordView => ({
  externalId: record.externalId,
  resource: record.resource,
  state: record.state,
  problem: record.problem,
  entityId: record.entityId,
  sourceCreatedAt: record.sourceCreatedAt,
  lastSeenAt: record.lastSeenAt,
  missingSince: record.missingSince,
});

function runView(run: SyncRun): SyncRunView {
  return {
    id: run.id,
    connectionId: run.connectionId,
    recordType: run.recordType,
    kind: run.kind,
    trigger: run.trigger,
    since: run.since,
    createdSince: run.createdSince ?? null,
    fullScan: run.fullScan,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    outcome: run.outcome,
    pages: run.pages,
    records: run.records,
    changed: run.changed,
    unchanged: run.unchanged,
    pending: run.pending,
    failed: run.failed,
    missing: run.missing,
    errors: run.errors,
  };
}

function streamView(
  stream: SyncStream,
  coverage: StreamCoverage | undefined,
  waiting: SyncStreamView['waiting'],
): SyncStreamView {
  const window = historyWindow(stream);
  const due =
    [stream.dueAt, ...(stream.scan ? [] : [stream.hintAt])]
      .filter((value): value is string => value !== null)
      .sort()[0] ?? null;
  const nextRunAt =
    due &&
    stream.providerDueAt &&
    Date.parse(stream.providerDueAt) > Date.parse(due)
      ? stream.providerDueAt
      : due;

  return {
    id: stream.id,
    status: streamStatus(stream, false, !!waiting),
    waiting,
    phase: stream.phase,
    paused: stream.paused,
    blocked: stream.blocked,
    scan: stream.scan
      ? {
          kind: stream.scan.kind,
          startedAt: stream.scan.startedAt,
          since: stream.scan.since,
          createdSince: stream.scan.createdSince ?? null,
          waitingForExport: stream.scan.waitingForExport ?? false,
          pages: stream.scan.pages,
          records: stream.scan.records,
          total: stream.scan.total,
        }
      : null,
    records: {
      total: coverage?.total ?? 0,
      current: coverage?.current ?? 0,
      pending: coverage?.pending ?? 0,
      failed: coverage?.failed ?? 0,
      missing: coverage?.missing ?? 0,
      retired: coverage?.retired ?? 0,
    },
    problems: coverage?.problems ?? [],
    coverage: {
      oldest: coverage?.oldest ?? null,
      newest: coverage?.newest ?? null,
      historyFrom: window.from,
      historyRequirement: window.requirement,
      olderHistoryAvailable: window.olderHistoryAvailable,
      recentFrom: stream.recentHistoryFrom ?? null,
      recentCompletedAt: stream.recentHistoryCompletedAt ?? null,
    },
    lastSuccessAt: stream.lastSuccessAt,
    lastCompleteAt: stream.lastCompleteAt,
    lastFullScanAt: stream.lastFullScanAt,
    backfillStartedAt: stream.backfillStartedAt,
    backfillCompletedAt: stream.backfillCompletedAt,
    nextRunAt: stream.paused || stream.blocked ? null : nextRunAt,
    error: stream.error ? { ...stream.error, attempts: stream.attempts } : null,
  };
}

const linkView = (request: LinkRequest): LinkRequestView => ({
  id: request.id,
  kind: request.kind,
  operation: request.operation,
  entityId: request.entityId,
  otherId: request.otherId,
  connectionId: request.connectionId,
  reason: request.reason,
  state: request.state,
  message: request.message,
  createdAt: request.createdAt,
  completedAt: request.completedAt,
});

/**
 * Operator view and controls for imports, sync and source identity links. Members can read;
 * people with `sync.manage` can control syncs and request links. Every call refreshes membership.
 */
export function createSyncService(deps: SyncServiceDependencies) {
  const now = deps.now ?? (() => new Date());
  const id = deps.id ?? (() => crypto.randomUUID());

  async function manager(context: TenantContext) {
    const fresh = await deps.refreshContext(context);
    requirePermission(fresh, 'sync.manage');

    return fresh;
  }

  function automaticLinks() {
    if (!deps.automaticLinks)
      throw unavailable('Automatic linking is unavailable.');

    return deps.automaticLinks;
  }

  async function sourcePolicy(
    context: TenantContext,
  ): Promise<{ hidden: string[]; fixed: string[] }> {
    return deps.sourcePolicy?.(context) ?? { hidden: [], fixed: [] };
  }

  /**
   * Resolves a stream read when its connection is listed and not withheld; otherwise reports
   * the stream as not found.
   */
  async function visible<T extends { connectionId: string }>(
    context: TenantContext,
    read: Promise<T | null>,
  ): Promise<T> {
    const [result, connections, policy] = await Promise.all([
      read,
      deps.connections.list(context),
      sourcePolicy(context),
    ]);
    if (
      !result ||
      policy.hidden.includes(result.connectionId) ||
      !connections.some((connection) => connection.id === result.connectionId)
    )
      throw notFound('Sync not found');

    return result;
  }

  async function overview(context: TenantContext): Promise<SyncOverview> {
    const fresh = await deps.refreshContext(context);
    const [connections, data, policy] = await Promise.all([
      deps.connections.list(fresh),
      deps.store.overview(fresh.tenantId),
      sourcePolicy(fresh),
    ]);
    const asOf = now();
    const coverage = new Map(
      data.coverage.map((item) => [item.streamId, item]),
    );

    const waiting = (stream: SyncStream): SyncStreamView['waiting'] => {
      const evidence = syncWait(stream, data.streams, asOf);
      if (!evidence) return null;
      const { connectionIds, ...reason } = evidence;

      return {
        ...reason,
        connections: connections
          .filter(
            (connection) =>
              connectionIds.includes(connection.id) &&
              !policy.hidden.includes(connection.id),
          )
          .map((connection) => ({
            connectionId: connection.id,
            label: connection.label,
          })),
      };
    };

    return {
      linkCoverage: await deps.store.linkCoverage(
        fresh.tenantId,
        policy.hidden,
      ),
      connections: connections
        .filter((connection) => !policy.hidden.includes(connection.id))
        .filter((connection) => {
          const streamed = data.streams.some(
            (s) => s.connectionId === connection.id,
          );
          // Connections without commerce records, such as mailboxes, have nothing to import.
          const imports = recordTypes.some((recordType) =>
            connection.permissions.includes(recordCapabilities[recordType]),
          );

          return (
            streamed ||
            (imports &&
              !['disconnected', 'revoked'].includes(connection.status))
          );
        })
        .map((connection): SyncConnectionView => {
          const streams = data.streams.filter(
            (stream) => stream.connectionId === connection.id,
          );

          return {
            connectionId: connection.id,
            label: connection.label,
            provider: connection.provider ?? connection.target.kind,
            appId: connection.appId ?? null,
            status: connection.status,
            recordTypes: recordTypes.map((recordType) => {
              const capability = recordCapabilities[recordType];
              const stream = streams.find((s) => s.recordType === recordType);

              return {
                recordType,
                availability: !connection.permissions.includes(capability)
                  ? 'not_requested'
                  : connection.granted.includes(capability)
                    ? 'granted'
                    : 'not_granted',
                stream: stream
                  ? streamView(stream, coverage.get(stream.id), waiting(stream))
                  : null,
              };
            }),
          };
        }),
      runs: data.runs
        .filter((run) => !policy.hidden.includes(run.connectionId))
        .map(runView),
      canManage: manage(fresh),
      asOf: asOf.toISOString(),
    };
  }

  return {
    overview,
    /**
     * Reads one page of a stream's runs, newest first; `before` continues after a run of the
     * previous page. A stream of a withheld or no longer listed connection is reported as not
     * found, like its other routes.
     */
    async runs(
      context: TenantContext,
      streamId: string,
      before?: string,
    ): Promise<{ runs: SyncRunView[]; nextCursor: string | null }> {
      const fresh = await deps.refreshContext(context);
      const history = await visible(
        fresh,
        deps.store.runs(fresh.tenantId, streamId, streamRunLimit + 1, before),
      );
      const runs = history.runs.slice(0, streamRunLimit);

      return {
        runs: runs.map(runView),
        nextCursor:
          history.runs.length > streamRunLimit ? runs.at(-1)!.id : null,
      };
    },
    /**
     * Lists one page of a stream's records that are waiting, could not be imported or are no
     * longer found, in source key order, under the same visibility as its runs. Throws 422 for
     * a cursor this route did not issue.
     */
    async records(
      context: TenantContext,
      streamId: string,
      state: RecordState,
      cursor?: string,
    ): Promise<{ records: SyncRecordView[]; nextCursor: string | null }> {
      const fresh = await deps.refreshContext(context);
      const after = cursor ? readRecordCursor(cursor) : undefined;
      const page = await visible(
        fresh,
        deps.store.records(
          fresh.tenantId,
          streamId,
          state,
          recordPageSize + 1,
          after,
        ),
      );
      const records = page.records.slice(0, recordPageSize);

      return {
        records: records.map(recordView),
        nextCursor:
          page.records.length > recordPageSize
            ? recordCursor(records.at(-1)!)
            : null,
      };
    },
    /** Reads automatic link rules with their current outcomes. */
    autoLinkRules: (context: TenantContext) =>
      automaticLinks().autoLinkRules(context),
    /** Previews a connection-pair rule without changing records. */
    previewAutoLinks: (
      ...args: Parameters<AutoLinkService['previewAutoLinks']>
    ) => automaticLinks().previewAutoLinks(...args),
    /** Saves a rule with revision checks and the caller's current access. */
    saveAutoLinkRule: (
      ...args: Parameters<AutoLinkService['saveAutoLinkRule']>
    ) => automaticLinks().saveAutoLinkRule(...args),
    /** Applies an operator command and returns the updated stream. */
    async command(
      context: TenantContext,
      streamId: string,
      command: StreamCommand['kind'],
    ): Promise<SyncStreamView> {
      const fresh = await manager(context);
      const visible = await overview(fresh);
      if (
        !visible.connections.some((connection) =>
          connection.recordTypes.some((item) => item.stream?.id === streamId),
        )
      )
        throw notFound('Sync not found');
      if (
        !(await deps.store.command(
          fresh.tenantId,
          streamId,
          { kind: command },
          fresh.actor.id,
        ))
      )
        throw notFound('Sync not found');
      const result = await overview(fresh);
      const view = result.connections
        .flatMap((connection) => connection.recordTypes)
        .find((item) => item.stream?.id === streamId)?.stream;
      if (!view) throw notFound('Sync not found');

      return view;
    },
    /**
     * Pauses, resumes or retries every sync of one connection that the command changes, in one
     * transaction, and returns how many changed with the connection's updated state. Resuming
     * and retrying continue with the caller's access.
     */
    async commandConnection(
      context: TenantContext,
      connectionId: string,
      command: ConnectionCommand,
    ): Promise<{ updated: number; connection: SyncConnectionView }> {
      const fresh = await manager(context);
      const listed = (await overview(fresh)).connections.some(
        (connection) => connection.connectionId === connectionId,
      );
      if (!listed) throw notFound('Connection not found');
      const updated = await deps.store.commandConnection(
        fresh.tenantId,
        connectionId,
        command,
        fresh.actor.id,
      );
      const connection = (await overview(fresh)).connections.find(
        (item) => item.connectionId === connectionId,
      );
      if (!connection) throw notFound('Connection not found');

      return { updated: updated.length, connection };
    },
    /** Reads source identity, suggestions and recent link requests with current access. */
    async identity(
      context: TenantContext,
      kind: 'sku' | 'location' | 'order' | 'order_line',
      entityId: string,
    ): Promise<IdentityDetail> {
      const fresh = await deps.refreshContext(context);
      const [detail, requests, policy] = await Promise.all([
        deps.identities(fresh.tenantId, kind, entityId),
        deps.store.linkRequests(fresh.tenantId, entityId),
        sourcePolicy(fresh),
      ]);
      if (!detail) throw notFound('Record not found');

      return {
        ...detail,
        sources: detail.sources.filter(
          (source) => !policy.hidden.includes(source.connectionId),
        ),
        suggestions: detail.suggestions.filter((suggestion) =>
          suggestion.sources.every(
            (source) =>
              ![...policy.hidden, ...policy.fixed].includes(
                source.connectionId,
              ),
          ),
        ),
        requests: requests
          .filter(
            (request) =>
              !request.connectionId ||
              !policy.hidden.includes(request.connectionId),
          )
          .map(linkView),
        canManage:
          manage(fresh) &&
          !detail.sources.some((source) =>
            policy.fixed.includes(source.connectionId),
          ),
      };
    },
    /** Records a link or unlink request; the sync worker applies it with the caller's access. */
    async requestLink(
      context: TenantContext,
      input: LinkInput,
    ): Promise<LinkRequestView> {
      const fresh = await manager(context);
      const detail = await deps.identities(
        fresh.tenantId,
        input.kind,
        input.entityId,
      );
      if (!detail) throw notFound('Record not found');
      const policy = await sourcePolicy(fresh);
      if (
        detail.sources.some((source) =>
          policy.fixed.includes(source.connectionId),
        )
      )
        throw conflict('This identity is anchored to an owned record');
      if (
        input.operation === 'unlink' &&
        policy.hidden.includes(input.connectionId)
      )
        throw notFound('Source not found');
      if (!input.reason.trim() || input.reason.trim().length > 2000)
        throw new ServiceError(
          422,
          'CONFLICT',
          'Give a reason of 1 to 2000 characters',
        );
      if (!detail.sources.length)
        throw new ServiceError(
          422,
          'CONFLICT',
          'This record has no current source',
        );
      if (input.operation === 'link') {
        if (input.otherId === input.entityId)
          throw new ServiceError(
            422,
            'CONFLICT',
            'Choose a different record to link',
          );
        const other = await deps.identities(
          fresh.tenantId,
          input.kind,
          input.otherId,
        );
        if (!other || !other.sources.length) throw notFound('Record not found');
        if (
          input.kind === 'order_line' &&
          (!detail.entity.orderId ||
            detail.entity.orderId !== other.entity.orderId ||
            !detail.entity.unit ||
            detail.entity.unit !== other.entity.unit)
        )
          throw new ServiceError(
            422,
            'CONFLICT',
            'Match current lines with the same units after linking their parent orders',
          );
        if (
          other.sources.some((source) =>
            [...policy.hidden, ...policy.fixed].includes(source.connectionId),
          )
        )
          throw conflict('This identity cannot be relinked');
        if (
          other.sources.some((source) =>
            detail.sources.some(
              (item) => item.connectionId === source.connectionId,
            ),
          )
        )
          throw new ServiceError(
            422,
            'CONFLICT',
            'Both records come from the same connection, so they cannot be the same record',
          );
      } else if (
        !detail.sources.some(
          (source) => source.connectionId === input.connectionId,
        ) ||
        detail.sources.length < 2
      )
        throw new ServiceError(
          422,
          'CONFLICT',
          'This source is not linked to another source',
        );

      return linkView(
        await deps.store.requestLink(fresh.tenantId, {
          id: id(),
          kind: input.kind,
          operation: input.operation,
          entityId: input.entityId,
          otherId: input.operation === 'link' ? input.otherId : null,
          connectionId:
            input.operation === 'unlink' ? input.connectionId : null,
          reason: input.reason,
          requestedBy: fresh.actor.id,
        }),
      );
    },
    /** Returns a link request's current state. */
    async linkRequest(
      context: TenantContext,
      requestId: string,
    ): Promise<LinkRequestView> {
      const fresh = await deps.refreshContext(context);
      const request = await deps.store.linkRequest(fresh.tenantId, requestId);
      if (!request) throw notFound('Link request not found');

      return linkView(request);
    },
  };
}

export type SyncService = ReturnType<typeof createSyncService>;
