import { orderChildren, type SyncStream } from './streams.js';

/** Scheduling evidence for a wait, evaluated against one tenant's current stream snapshot. */
export interface SyncWait {
  reason:
    | 'orders'
    | 'request_capacity'
    | 'admission_unavailable'
    | 'provider_cooldown'
    | 'worker_capacity'
    | 'connection_capacity'
    | 'recent_changes'
    | 'queued';
  connectionIds: string[];
  observedAt: string;
  until: string | null;
}

/** Explains idle work without treating manual pauses, failures or scheduled checks as waits. */
export function syncWait(
  stream: SyncStream,
  streams: readonly SyncStream[],
  now: Date,
): SyncWait | null {
  if (stream.paused || stream.blocked || stream.error) return null;
  const leased = (item: SyncStream) =>
    !!item.leaseUntil && Date.parse(item.leaseUntil) > +now;
  if (leased(stream)) return null;
  const wait = (
    reason: SyncWait['reason'],
    connectionIds: string[] = [],
    until: string | null = null,
    observedAt = now.toISOString(),
  ): SyncWait => ({ reason, connectionIds, observedAt, until });
  if (
    orderChildren.includes(stream.recordType) &&
    stream.phase === 'backfill' &&
    !stream.scan &&
    streams.some(
      (item) =>
        item.tenantId === stream.tenantId &&
        item.connectionId === stream.connectionId &&
        item.recordType === 'orders' &&
        item.phase === 'backfill' &&
        !item.recentHistoryCompletedAt &&
        !item.blocked,
    )
  )
    return wait('orders', [stream.connectionId]);
  const due = stream.scan
    ? stream.dueAt
    : [stream.dueAt, stream.hintAt].filter((value) => value !== null).sort()[0];
  if (
    stream.providerDueAt &&
    Date.parse(stream.providerDueAt) > +now &&
    (stream.scan ||
      stream.phase === 'backfill' ||
      (due && Date.parse(due) <= +now))
  )
    return wait('provider_cooldown', [], stream.providerDueAt);
  if (stream.admissionWait && stream.dueAt && Date.parse(stream.dueAt) > +now)
    return wait(
      stream.admissionWait.reason,
      [],
      stream.dueAt,
      stream.admissionWait.observedAt,
    );
  if (!due || Date.parse(due) > +now) return null;
  // Other tenants must never supply blocker identities, even to a caller with mixed input.
  const active = streams.filter(
    (item) => item.tenantId === stream.tenantId && leased(item),
  );
  const sameConnection = active.filter(
    (item) => item.connectionId === stream.connectionId,
  );
  const capacityWait = (reason: SyncWait['reason'], holders: SyncStream[]) =>
    wait(
      reason,
      [...new Set(holders.map((item) => item.connectionId))],
      holders.map((item) => item.leaseUntil!).sort()[0] ?? null,
    );
  const connectionLimit = sameConnection[0]?.leaseConnectionConcurrency;
  if (connectionLimit && sameConnection.length >= connectionLimit)
    return capacityWait(
      sameConnection.every((item) => item.scan?.kind === 'incremental')
        ? 'recent_changes'
        : 'connection_capacity',
      sameConnection,
    );
  const workspaceLimit = active[0]?.leaseWorkspaceConcurrency;
  if (workspaceLimit && active.length >= workspaceLimit)
    return capacityWait('worker_capacity', active);

  return wait('queued');
}
