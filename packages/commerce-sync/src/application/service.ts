import type { ConnectionManagement } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import {
  hasPermission,
  IdentityError,
  requirePermission,
} from '@luma/identity';

import {
  historyWindow,
  orderChildren,
  recordCapabilities,
  recordTypes,
  streamStatus,
  type SyncStream,
} from '../domain/streams.js';
import type {
  LinkRequest,
  StreamCommand,
  StreamCoverage,
  SyncStore,
} from './ports.js';
import type {
  IdentityDetail,
  LinkInput,
  LinkRequestView,
  SyncConnectionView,
  SyncOverview,
  SyncStreamView,
} from './views.js';

/** Reads a canonical record's sources and suggestions for a person to review. */
export type IdentityReader = (
  tenantId: string,
  kind: 'sku' | 'location' | 'order',
  entityId: string,
) => Promise<Omit<IdentityDetail, 'requests' | 'canManage'> | null>;

export interface SyncServiceDependencies {
  store: SyncStore;
  connections: Pick<ConnectionManagement, 'list'>;
  identities: IdentityReader;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  now?: () => Date;
  id?: () => string;
}

const manage = (context: TenantContext) =>
  hasPermission(context, 'sync.manage');

function streamView(
  stream: SyncStream,
  coverage: StreamCoverage | undefined,
  waitingOnOrders: boolean,
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
    status: streamStatus(stream, waitingOnOrders),
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

  async function overview(context: TenantContext): Promise<SyncOverview> {
    const fresh = await deps.refreshContext(context);
    const [connections, data] = await Promise.all([
      deps.connections.list(fresh),
      deps.store.overview(fresh.tenantId),
    ]);
    const coverage = new Map(
      data.coverage.map((item) => [item.streamId, item]),
    );

    return {
      connections: connections
        .filter(
          (connection) =>
            !['disconnected', 'revoked'].includes(connection.status) ||
            data.streams.some((s) => s.connectionId === connection.id),
        )
        .map((connection): SyncConnectionView => {
          const streams = data.streams.filter(
            (stream) => stream.connectionId === connection.id,
          );
          const ordersImporting = streams.some(
            (stream) =>
              stream.recordType === 'orders' &&
              stream.phase === 'backfill' &&
              !stream.recentHistoryCompletedAt,
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
                  ? streamView(
                      stream,
                      coverage.get(stream.id),
                      orderChildren.includes(recordType) && ordersImporting,
                    )
                  : null,
              };
            }),
          };
        }),
      runs: data.runs.map((run) => ({
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
      })),
      canManage: manage(fresh),
      asOf: now().toISOString(),
    };
  }

  return {
    overview,
    /** Applies an operator command and returns the updated stream. */
    async command(
      context: TenantContext,
      streamId: string,
      command: StreamCommand['kind'],
    ): Promise<SyncStreamView> {
      const fresh = await manager(context);
      if (
        !(await deps.store.command(
          fresh.tenantId,
          streamId,
          { kind: command },
          fresh.actor.id,
        ))
      )
        throw new IdentityError(404, 'NOT_FOUND', 'Sync not found');
      const result = await overview(fresh);
      const view = result.connections
        .flatMap((connection) => connection.recordTypes)
        .find((item) => item.stream?.id === streamId)?.stream;
      if (!view) throw new IdentityError(404, 'NOT_FOUND', 'Sync not found');

      return view;
    },
    /** Reads source identity, suggestions and recent link requests with current access. */
    async identity(
      context: TenantContext,
      kind: 'sku' | 'location' | 'order',
      entityId: string,
    ): Promise<IdentityDetail> {
      const fresh = await deps.refreshContext(context);
      const [detail, requests] = await Promise.all([
        deps.identities(fresh.tenantId, kind, entityId),
        deps.store.linkRequests(fresh.tenantId, entityId),
      ]);
      if (!detail)
        throw new IdentityError(404, 'NOT_FOUND', 'Record not found');

      return {
        ...detail,
        requests: requests.map(linkView),
        canManage: manage(fresh),
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
      if (!detail)
        throw new IdentityError(404, 'NOT_FOUND', 'Record not found');
      if (!input.reason.trim() || input.reason.trim().length > 2000)
        throw new IdentityError(
          422,
          'CONFLICT',
          'Give a reason of 1 to 2000 characters',
        );
      if (!detail.sources.length)
        throw new IdentityError(
          422,
          'CONFLICT',
          'This record has no current source',
        );
      if (input.operation === 'link') {
        if (input.otherId === input.entityId)
          throw new IdentityError(
            422,
            'CONFLICT',
            'Choose a different record to link',
          );
        const other = await deps.identities(
          fresh.tenantId,
          input.kind,
          input.otherId,
        );
        if (!other || !other.sources.length)
          throw new IdentityError(404, 'NOT_FOUND', 'Record not found');
        if (
          other.sources.some((source) =>
            detail.sources.some(
              (item) => item.connectionId === source.connectionId,
            ),
          )
        )
          throw new IdentityError(
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
        throw new IdentityError(
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
      if (!request)
        throw new IdentityError(404, 'NOT_FOUND', 'Link request not found');

      return linkView(request);
    },
  };
}

export type SyncService = ReturnType<typeof createSyncService>;
