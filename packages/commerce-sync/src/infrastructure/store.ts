import type { SqlTransaction, TenantDatabase } from '@luma/platform';

import type {
  ItemKey,
  LinkRequest,
  RecordState,
  StreamCommand,
  StreamCoverage,
  SyncConnection,
  SyncRecordProblem,
  SyncRun,
  SyncStore,
} from '../application/ports.js';
import { itemKey } from '../application/ports.js';
import {
  recordCapabilities,
  type RecordType,
  type SyncStream,
} from '../domain/streams.js';

// Cross-tenant discovery runs through a security-definer function that returns tenant IDs only.
const discoveryTenant = '00000000-0000-4000-8000-000000000000';

type StreamRow = {
  tenant_id: string;
  id: string;
  connection_id: string;
  record_type: RecordType;
  principal_id: string;
  paused: boolean;
  phase: SyncStream['phase'];
  scan: NonNullable<SyncStream['scan']>['kind'] | null;
  scan_id: string | null;
  cursor: string | null;
  scan_started_at: Date | null;
  scan_since: Date | null;
  scan_pages: number;
  scan_records: number;
  scan_total: number | null;
  scan_created_since: Date | null;
  scan_waiting: boolean;
  recent_history_from: Date | null;
  recent_history_completed_at: Date | null;
  suspended_scan: SyncStream['scan'];
  live_due_at: Date | null;
  provider_due_at: Date | null;
  lease_until: Date | null;
  lease_workspace_concurrency: number | null;
  lease_connection_concurrency: number | null;
  admission_wait_reason: 'request_capacity' | 'admission_unavailable' | null;
  admission_wait_at: Date | null;
  full_requested: boolean;
  watermark: Date | null;
  history_from: Date | null;
  history_requirement: string | null;
  current_history_limited: boolean;
  due_at: Date | null;
  hint_at: Date | null;
  attempts: number;
  error_code: string | null;
  error_message: string | null;
  error_at: Date | null;
  failing_since: Date | null;
  blocked: SyncStream['blocked'];
  last_success_at: Date | null;
  last_complete_at: Date | null;
  last_full_scan_at: Date | null;
  backfill_started_at: Date | null;
  backfill_completed_at: Date | null;
  version: number;
};

const iso = (value: Date | null) => value?.toISOString() ?? null;

type RunRow = {
  id: string;
  stream_id: string;
  connection_id: string;
  record_type: RecordType;
  kind: SyncRun['kind'];
  trigger: SyncRun['trigger'];
  since: Date | null;
  created_since: Date | null;
  full_scan: boolean;
  started_at: Date;
  finished_at: Date | null;
  outcome: SyncRun['outcome'];
  pages: number;
  records: number;
  changed: number;
  unchanged: number;
  pending: number;
  failed: number;
  missing: number | null;
  errors: number;
};

const run = (row: RunRow): SyncRun => ({
  id: row.id,
  streamId: row.stream_id,
  connectionId: row.connection_id,
  recordType: row.record_type,
  kind: row.kind,
  trigger: row.trigger,
  since: iso(row.since),
  createdSince: iso(row.created_since),
  fullScan: row.full_scan,
  startedAt: row.started_at.toISOString(),
  finishedAt: iso(row.finished_at),
  outcome: row.outcome,
  pages: row.pages,
  records: row.records,
  changed: row.changed,
  unchanged: row.unchanged,
  pending: row.pending,
  failed: row.failed,
  missing: row.missing,
  errors: row.errors,
});

function stream(row: StreamRow): SyncStream {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    connectionId: row.connection_id,
    recordType: row.record_type,
    principalId: row.principal_id,
    paused: row.paused,
    phase: row.phase,
    scan:
      row.scan && row.scan_id && row.scan_started_at
        ? {
            id: row.scan_id,
            kind: row.scan,
            cursor: row.cursor,
            startedAt: row.scan_started_at.toISOString(),
            since: iso(row.scan_since),
            createdSince: iso(row.scan_created_since),
            waitingForExport: row.scan_waiting,
            pages: row.scan_pages,
            records: row.scan_records,
            total: row.scan_total,
          }
        : null,
    suspendedScan: row.suspended_scan,
    recentHistoryFrom: iso(row.recent_history_from),
    recentHistoryCompletedAt: iso(row.recent_history_completed_at),
    liveDueAt: iso(row.live_due_at),
    providerDueAt: iso(row.provider_due_at),
    leaseUntil: iso(row.lease_until),
    leaseWorkspaceConcurrency: row.lease_workspace_concurrency,
    leaseConnectionConcurrency: row.lease_connection_concurrency,
    admissionWait:
      row.admission_wait_reason && row.admission_wait_at
        ? {
            reason: row.admission_wait_reason,
            observedAt: row.admission_wait_at.toISOString(),
          }
        : null,
    fullRequested: row.full_requested,
    watermark: iso(row.watermark),
    historyFrom: iso(row.history_from),
    historyRequirement: row.history_requirement,
    currentHistoryLimited: row.current_history_limited,
    dueAt: iso(row.due_at),
    hintAt: iso(row.hint_at),
    attempts: row.attempts,
    error:
      row.error_code && row.error_message && row.error_at
        ? {
            code: row.error_code,
            message: row.error_message,
            at: row.error_at.toISOString(),
          }
        : null,
    failingSince: iso(row.failing_since),
    blocked: row.blocked,
    lastSuccessAt: iso(row.last_success_at),
    lastCompleteAt: iso(row.last_complete_at),
    lastFullScanAt: iso(row.last_full_scan_at),
    backfillStartedAt: iso(row.backfill_started_at),
    backfillCompletedAt: iso(row.backfill_completed_at),
    version: row.version,
  };
}

type LinkRow = {
  id: string;
  kind: LinkRequest['kind'];
  operation: LinkRequest['operation'];
  entity_id: string;
  other_id: string | null;
  connection_id: string | null;
  reason: string;
  requested_by: string;
  state: LinkRequest['state'];
  message: string | null;
  created_at: Date;
  completed_at: Date | null;
};

function link(row: LinkRow): LinkRequest {
  return {
    id: row.id,
    kind: row.kind,
    operation: row.operation,
    entityId: row.entity_id,
    otherId: row.other_id,
    connectionId: row.connection_id,
    reason: row.reason,
    requestedBy: row.requested_by,
    state: row.state,
    message: row.message,
    createdAt: row.created_at.toISOString(),
    completedAt: iso(row.completed_at),
  };
}

/** Ledger filters for the record states people can list; missing excludes confirmed deletions. */
const recordStates: Record<RecordState, string> = {
  pending: "status='pending'",
  failed: "status='failed'",
  missing: "missing_since IS NOT NULL AND status<>'retired'",
};

const recordTypeCase = `CASE cap ${Object.entries(recordCapabilities)
  .map(([type, capability]) => `WHEN '${capability}' THEN '${type}'`)
  .join(' ')} END`;

/**
 * Folds a stream's ledger count changes into one row. Ledger triggers append a row per
 * statement; the page commit, which holds the stream lock, keeps the rows per stream few.
 * Changes appended by uncommitted transactions are folded by a later page.
 */
async function foldItemCounts(tx: SqlTransaction, scope: unknown[]) {
  await tx.query(
    `WITH folded AS (
      DELETE FROM commerce_sync_item_counts c WHERE c.tenant_id=$1 AND c.connection_id=$2 AND c.record_type=$3
        AND (SELECT count(*) FROM commerce_sync_item_counts WHERE tenant_id=$1 AND connection_id=$2 AND record_type=$3)>1
      RETURNING c.*
    ) INSERT INTO commerce_sync_item_counts(tenant_id,connection_id,record_type,total,current,pending,failed,retired,missing)
    SELECT $1,$2,$3,sum(total),sum(current),sum(pending),sum(failed),sum(retired),sum(missing)
    FROM folded HAVING count(*)>0`,
    scope,
  );
}

async function lockStream(
  tx: SqlTransaction,
  tenantId: string,
  streamId: string,
  token: string,
) {
  return (
    await tx.query<StreamRow>(
      'SELECT * FROM commerce_sync_streams WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 FOR UPDATE',
      [tenantId, streamId, token],
    )
  ).rows[0];
}

/** Applies an operator command to a stream the transaction has locked. */
async function applyCommand(
  tx: SqlTransaction,
  current: StreamRow,
  command: StreamCommand,
  principalId: string,
) {
  const values = [current.tenant_id, current.id, principalId];
  if (command.kind === 'pause')
    await tx.query(
      'UPDATE commerce_sync_streams SET paused=true,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2',
      values.slice(0, 2),
    );
  else if (command.kind === 'reimport') {
    if (current.scan_id || current.suspended_scan)
      await tx.query(
        `UPDATE commerce_sync_runs SET outcome='cancelled',finished_at=now()
        WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND outcome='running'`,
        [
          current.tenant_id,
          [current.scan_id, current.suspended_scan?.id].filter(Boolean),
        ],
      );
    await tx.query(
      `UPDATE commerce_sync_streams SET phase='backfill',scan=NULL,scan_id=NULL,cursor=NULL,scan_started_at=NULL,
        scan_since=NULL,scan_created_since=NULL,recent_history_from=NULL,recent_history_completed_at=NULL,suspended_scan=NULL,live_due_at=NULL,scan_pages=0,scan_records=0,scan_total=NULL,full_requested=true,paused=false,
        principal_id=$3,blocked=CASE WHEN blocked='principal_unavailable' THEN NULL ELSE blocked END,
        lease_token=NULL,lease_until=NULL,due_at=now(),attempts=0,error_code=NULL,error_message=NULL,
        error_at=NULL,failing_since=NULL,admission_wait_reason=NULL,admission_wait_at=NULL,version=version+1,updated_at=now()
      WHERE tenant_id=$1 AND id=$2`,
      values,
    );
  } else
    await tx.query(
      `UPDATE commerce_sync_streams SET paused=false,principal_id=$3,
        blocked=CASE WHEN blocked='principal_unavailable' THEN NULL ELSE blocked END,
        full_requested=full_requested OR $4,due_at=LEAST(COALESCE(due_at,now()),now()),
        admission_wait_reason=NULL,admission_wait_at=NULL,
        version=version+1,updated_at=now()
      WHERE tenant_id=$1 AND id=$2`,
      [...values, command.kind === 'reconcile'],
    );
}

/** PostgreSQL persistence for sync streams, runs, the import ledger and link requests. */
export function createSyncStore(db: TenantDatabase): SyncStore {
  return {
    async scopes() {
      return db.transaction(discoveryTenant, async (tx) =>
        (
          await tx.query<{ tenant_id: string }>(
            'SELECT tenant_id FROM commerce_sync_scopes()',
          )
        ).rows.map((row) => row.tenant_id),
      );
    },
    async connections(tenantId) {
      return db.transaction(tenantId, async (tx) =>
        (
          await tx.query<{
            id: string;
            label: string;
            provider: string;
            status: SyncConnection['status'];
            granted: string[];
            installer_id: string | null;
          }>(
            `SELECT i.id,i.document->>'label' AS label,COALESCE(i.document->>'provider',i.document->'target'->>'kind') AS provider,
              i.document->>'status' AS status,
              ARRAY(SELECT jsonb_array_elements_text(i.document->'granted')
                INTERSECT SELECT jsonb_array_elements_text(i.document->'permissions')) AS granted,
              (SELECT e.actor_id FROM connector_lifecycle_events e WHERE e.tenant_id=i.tenant_id
                AND e.connection_id=i.id ORDER BY e.version LIMIT 1) AS installer_id
            FROM connector_installations i WHERE i.tenant_id=$1 ORDER BY i.id`,
            [tenantId],
          )
        ).rows.map((row) => ({
          id: row.id,
          label: row.label,
          provider: row.provider,
          status: row.status,
          granted: row.granted,
          installerId: row.installer_id,
        })),
      );
    },
    async streams(tenantId) {
      return db.transaction(tenantId, async (tx) =>
        (
          await tx.query<StreamRow>(
            'SELECT * FROM commerce_sync_streams WHERE tenant_id=$1 ORDER BY connection_id,record_type',
            [tenantId],
          )
        ).rows.map(stream),
      );
    },
    async createStreams(tenantId, connectionId, recordTypes, principalId) {
      await db.transaction(tenantId, async (tx) => {
        await tx.query(
          `INSERT INTO commerce_sync_streams(tenant_id,id,connection_id,record_type,principal_id,phase,due_at)
          SELECT $1,gen_random_uuid(),$2,t,$3,'backfill',now() FROM unnest($4::text[]) t
          ON CONFLICT(tenant_id,connection_id,record_type) DO NOTHING`,
          [tenantId, connectionId, principalId, recordTypes],
        );
      });
    },
    async setBlocked(tenantId, streamIds, reason) {
      if (!streamIds.length) return;
      await db.transaction(tenantId, async (tx) => {
        await tx.query(
          `UPDATE commerce_sync_streams SET blocked=$3,lease_token=NULL,lease_until=NULL,
            due_at=CASE WHEN $3::text IS NULL THEN now() ELSE due_at END,version=version+1,updated_at=now()
          WHERE tenant_id=$1 AND id=ANY($2::uuid[])`,
          [tenantId, streamIds, reason],
        );
      });
    },
    async applyHints(tenantId, delayMs) {
      return db.transaction(tenantId, async (tx) => {
        const result = await tx.query(
          `WITH hints AS (
            UPDATE connector_refresh_hints SET consumed_at=now()
            WHERE tenant_id=$1 AND consumed_at IS NULL RETURNING connection_id,capabilities,received_at,reconcile
          ), latest AS (
            SELECT connection_id,${recordTypeCase} AS record_type,min(received_at) AS received_at,bool_or(reconcile) AS reconcile
            FROM hints CROSS JOIN LATERAL unnest(capabilities) cap GROUP BY 1,2
          )
          UPDATE commerce_sync_streams s SET hint_at=LEAST(COALESCE(s.hint_at,'infinity'),
            l.received_at+($2::integer*interval '1 millisecond')),full_requested=s.full_requested OR l.reconcile,updated_at=now()
          FROM latest l WHERE s.tenant_id=$1 AND s.connection_id=l.connection_id AND s.record_type=l.record_type`,
          [tenantId, delayMs],
        );
        await tx.query(
          "DELETE FROM connector_refresh_hints WHERE tenant_id=$1 AND consumed_at < now() - interval '7 days'",
          [tenantId],
        );

        return result.rowCount ?? 0;
      });
    },
    async claim(tenantId, token, leaseMs, options = {}) {
      return db.transaction(tenantId, async (tx) => {
        // Serialize admission only, not provider reads: limits hold across worker processes.
        await tx.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 51))',
          [tenantId],
        );
        const row = (
          await tx.query<StreamRow>(
            `WITH candidate AS (
              SELECT s.id FROM commerce_sync_streams s
              WHERE s.tenant_id=$1 AND NOT s.paused AND s.blocked IS NULL
                AND (s.lease_until IS NULL OR s.lease_until < now())
                AND ($4::uuid IS NULL OR s.connection_id=$4)
                AND (SELECT count(*) FROM commerce_sync_streams active WHERE active.tenant_id=s.tenant_id
                  AND active.lease_until > now()) < $6
                AND (s.provider_due_at IS NULL OR s.provider_due_at <= now())
                AND (SELECT count(*) FROM commerce_sync_streams busy WHERE busy.tenant_id=s.tenant_id
                  AND busy.connection_id=s.connection_id AND busy.lease_until > now()) < $5
                AND (s.due_at <= now() OR (s.scan IS NULL AND s.hint_at <= now()))
                -- Fulfillments and returns refer to orders, so their history waits for the order history.
                AND NOT (s.record_type IN ('fulfillments','returns') AND s.phase='backfill' AND EXISTS (
                  SELECT 1 FROM commerce_sync_streams o WHERE o.tenant_id=s.tenant_id
                  AND o.connection_id=s.connection_id AND o.record_type='orders'
                  AND o.phase='backfill' AND o.recent_history_completed_at IS NULL AND o.blocked IS NULL))
              ORDER BY CASE
                WHEN s.scan='incremental' OR (s.scan IS NULL AND s.phase='incremental' AND s.hint_at <= now())
                  OR (s.live_enabled AND s.suspended_scan IS NULL AND s.scan IN ('backfill','reconcile')
                    AND (s.hint_at <= now() OR s.live_due_at <= now())) THEN 0
                WHEN s.phase='backfill' AND s.scan IS NULL AND s.backfill_started_at IS NULL AND s.record_type IN ('orders','fulfillments','returns') THEN 1
                ELSE 2 END,
                CASE WHEN s.scan IS NOT NULL THEN s.due_at ELSE LEAST(s.due_at,s.hint_at) END NULLS LAST,s.id
              LIMIT 1 FOR UPDATE SKIP LOCKED
            )
            UPDATE commerce_sync_streams s SET lease_token=$2,
              lease_until=now()+($3::integer*interval '1 millisecond'),updated_at=now(),
              lease_workspace_concurrency=$6,lease_connection_concurrency=$5,
              admission_wait_reason=NULL,admission_wait_at=NULL
            FROM candidate c WHERE s.tenant_id=$1 AND s.id=c.id RETURNING s.*`,
            [
              tenantId,
              token,
              leaseMs,
              options.connectionId ?? null,
              options.connectionConcurrency ?? 1,
              options.workspaceConcurrency ?? 4,
            ],
          )
        ).rows[0];

        return row ? stream(row) : null;
      });
    },
    async suspendScan(tenantId, streamId, token) {
      return db.transaction(tenantId, async (tx) => {
        const current = await lockStream(tx, tenantId, streamId, token);
        if (!current) return null;
        const checkpoint = stream(current).scan;
        if (
          !checkpoint ||
          checkpoint.kind === 'incremental' ||
          current.suspended_scan
        )
          return stream(current);
        const row = (
          await tx.query<StreamRow>(
            `UPDATE commerce_sync_streams SET suspended_scan=$4,scan=NULL,scan_id=NULL,cursor=NULL,scan_created_since=NULL
           WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 RETURNING *`,
            [tenantId, streamId, token, checkpoint],
          )
        ).rows[0]!;

        return stream(row);
      });
    },
    async deferConnection(tenantId, connectionId, dueAt) {
      await db.transaction(tenantId, async (tx) => {
        await tx.query(
          `UPDATE commerce_sync_streams SET provider_due_at=GREATEST(provider_due_at,$3::timestamptz)
          WHERE tenant_id=$1 AND connection_id=$2`,
          [tenantId, connectionId, dueAt],
        );
      });
    },
    async startScan(tenantId, streamId, token, run) {
      return db.transaction(tenantId, async (tx) => {
        const row = (
          await tx.query<StreamRow>(
            `UPDATE commerce_sync_streams SET scan=$4,scan_id=$5,cursor=NULL,scan_started_at=$6,scan_since=$7,
              scan_pages=0,scan_records=0,scan_total=NULL,
              full_requested=CASE WHEN $8 THEN false ELSE full_requested END,
              scan_created_since=$9,scan_waiting=false,live_enabled=$10,
              recent_history_from=COALESCE(recent_history_from,$9::timestamptz),
              live_due_at=COALESCE(live_due_at,$6::timestamptz+interval '5 minutes'),
              backfill_started_at=CASE WHEN $4='backfill' THEN COALESCE(backfill_started_at,$6) ELSE backfill_started_at END,
              hint_at=CASE WHEN hint_at <= $6 THEN NULL ELSE hint_at END,updated_at=now()
            WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 AND scan IS NULL RETURNING *`,
            [
              tenantId,
              streamId,
              token,
              run.plan.kind,
              run.id,
              run.now,
              run.plan.since,
              run.fullScan,
              run.plan.createdSince ?? null,
              run.liveEnabled ?? false,
            ],
          )
        ).rows[0];
        if (!row) return null;
        await tx.query(
          `INSERT INTO commerce_sync_runs(tenant_id,id,stream_id,kind,trigger,since,full_scan,started_at,outcome,created_since)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running',$9)`,
          [
            tenantId,
            run.id,
            streamId,
            run.plan.kind,
            run.plan.trigger,
            run.plan.since,
            run.fullScan,
            run.now,
            run.plan.createdSince ?? null,
          ],
        );

        return stream(row);
      });
    },
    async ledger(tenantId, connectionId, recordType, keys) {
      const found = new Map<
        string,
        { digest: string; status: 'current' | 'pending' | 'failed' | 'retired' }
      >();
      if (!keys.length) return found;
      const rows = await db.transaction(
        tenantId,
        async (tx) =>
          (
            await tx.query<{
              resource: string;
              scope_key: string;
              external_id: string;
              digest: string;
              status: 'current' | 'pending' | 'failed' | 'retired';
            }>(
              `SELECT i.resource,i.scope_key,i.external_id,i.digest,i.status
            FROM unnest($4::text[],$5::text[],$6::text[]) AS k(resource,scope_key,external_id)
            JOIN commerce_sync_items i ON i.tenant_id=$1 AND i.connection_id=$2 AND i.record_type=$3
              AND i.resource=k.resource AND i.scope_key=k.scope_key AND i.external_id=k.external_id`,
              [
                tenantId,
                connectionId,
                recordType,
                keys.map((key) => key.resource),
                keys.map((key) => key.scopeKey),
                keys.map((key) => key.externalId),
              ],
            )
          ).rows,
      );
      for (const row of rows)
        found.set(
          itemKey({
            resource: row.resource as Parameters<typeof itemKey>[0]['resource'],
            scopeKey: row.scope_key,
            externalId: row.external_id,
          }),
          { digest: row.digest, status: row.status },
        );

      return found;
    },
    async missingSince(tenantId, connectionId, recordType, before, limit) {
      return db.transaction(
        tenantId,
        async (tx) =>
          (
            await tx.query<ItemKey>(
              `SELECT resource,scope_key AS "scopeKey",external_id AS "externalId" FROM commerce_sync_items
              WHERE tenant_id=$1 AND connection_id=$2 AND record_type=$3 AND missing_since < $4 AND status<>'retired'
              ORDER BY missing_since,external_id LIMIT $5`,
              [tenantId, connectionId, recordType, before, limit],
            )
          ).rows,
      );
    },
    async confirmationCandidates(tenantId, connectionId, recordType, limit) {
      return db.transaction(
        tenantId,
        async (tx) =>
          (
            await tx.query<ItemKey & { createdAt: string | null }>(
              `SELECT resource,scope_key AS "scopeKey",external_id AS "externalId",source_created_at::text AS "createdAt"
         FROM commerce_sync_items WHERE tenant_id=$1 AND connection_id=$2 AND record_type=$3 AND missing_since IS NOT NULL AND status<>'retired'
         ORDER BY COALESCE(confirmation_checked_at,missing_since),external_id LIMIT $4`,
              [tenantId, connectionId, recordType, limit],
            )
          ).rows,
      );
    },
    async recordConfirmation(
      tenantId,
      connectionId,
      recordType,
      item,
      outcome,
    ) {
      await db.transaction(tenantId, (tx) =>
        tx.query(
          `UPDATE commerce_sync_items SET confirmation_checked_at=now(),
        status=CASE WHEN $7='deleted' THEN 'retired' ELSE status END,
        problem=CASE WHEN $7='history_limited' THEN 'Older records require full history access to confirm deletion'
          WHEN $7='missing' THEN 'Source record missing; deletion is unconfirmed' ELSE NULL END
        WHERE tenant_id=$1 AND connection_id=$2 AND record_type=$3 AND resource=$4 AND scope_key=$5 AND external_id=$6 AND missing_since IS NOT NULL`,
          [
            tenantId,
            connectionId,
            recordType,
            item.resource,
            item.scopeKey,
            item.externalId,
            outcome,
          ],
        ),
      );
    },
    async commitPage(tenantId, streamId, token, page) {
      return db.transaction(tenantId, async (tx) => {
        const current = await lockStream(tx, tenantId, streamId, token);
        if (!current?.scan_id || !current.scan || !current.scan_started_at)
          return false;
        if (page.deferred) {
          await tx.query(
            `UPDATE commerce_sync_streams SET cursor=$4,due_at=$5,scan_waiting=CASE WHEN $6='admission' THEN scan_waiting ELSE true END,lease_token=NULL,lease_until=NULL,
              admission_wait_reason=$7,admission_wait_at=CASE WHEN $7::text IS NULL THEN NULL ELSE $8::timestamptz END
            WHERE tenant_id=$1 AND id=$2 AND lease_token=$3`,
            [
              tenantId,
              streamId,
              token,
              page.nextCursor,
              page.dueAt ?? page.now,
              page.deferReason ?? 'export',
              page.admissionWaitReason ?? null,
              page.now,
            ],
          );

          return true;
        }
        const scope = [tenantId, current.connection_id, current.record_type];
        if (page.entries.length)
          await tx.query(
            `INSERT INTO commerce_sync_items AS i(tenant_id,connection_id,record_type,resource,scope_key,external_id,
              digest,status,problem,entity_id,source_created_at,source_updated_at,first_seen_at,last_seen_at,changed_at,
              first_seen_by,seen_scan_id)
            SELECT $1,$2,$3,e.resource,e."scopeKey",e."externalId",e.digest,e.status,e.problem,e."entityId",
              e."sourceCreatedAt",e."sourceUpdatedAt",$5,$5,$5,$6,$7
            FROM jsonb_to_recordset($4::jsonb) AS e(resource text,"scopeKey" text,"externalId" text,digest text,
              status text,problem text,"entityId" uuid,"sourceCreatedAt" timestamptz,"sourceUpdatedAt" timestamptz)
            ON CONFLICT(tenant_id,connection_id,record_type,resource,scope_key,external_id) DO UPDATE SET
              digest=EXCLUDED.digest,status=EXCLUDED.status,problem=EXCLUDED.problem,
              entity_id=COALESCE(EXCLUDED.entity_id,i.entity_id),
              source_created_at=COALESCE(EXCLUDED.source_created_at,i.source_created_at),
              source_updated_at=EXCLUDED.source_updated_at,last_seen_at=EXCLUDED.last_seen_at,
              changed_at=CASE WHEN i.digest<>EXCLUDED.digest THEN EXCLUDED.changed_at ELSE i.changed_at END,
              seen_scan_id=EXCLUDED.seen_scan_id,missing_since=NULL`,
            [
              ...scope,
              JSON.stringify(page.entries),
              page.now,
              current.scan,
              current.scan_id,
            ],
          );
        if (page.unchanged.length)
          await tx.query(
            `UPDATE commerce_sync_items i SET last_seen_at=$5,seen_scan_id=$6,missing_since=NULL
            FROM jsonb_to_recordset($4::jsonb) AS e(resource text,"scopeKey" text,"externalId" text)
            WHERE i.tenant_id=$1 AND i.connection_id=$2 AND i.record_type=$3
              AND i.resource=e.resource AND i.scope_key=e."scopeKey" AND i.external_id=e."externalId"`,
            [
              ...scope,
              JSON.stringify(page.unchanged),
              page.now,
              current.scan_id,
            ],
          );
        await tx.query(
          `UPDATE commerce_sync_runs SET pages=pages+1,records=records+$3,changed=changed+$4,
            unchanged=unchanged+$5,pending=pending+$6,failed=failed+$7
          WHERE tenant_id=$1 AND id=$2`,
          [
            tenantId,
            current.scan_id,
            page.counts.records,
            page.counts.changed,
            page.counts.unchanged,
            page.counts.pending,
            page.counts.failed,
          ],
        );
        const history = page.history;
        const firstBackfillPage =
          current.scan === 'backfill' && current.scan_pages === 0;
        await tx.query(
          `UPDATE commerce_sync_streams SET cursor=$4,scan_waiting=false,scan_pages=scan_pages+1,scan_records=scan_records+$5,
            scan_total=COALESCE($6,scan_total),attempts=0,error_code=NULL,error_message=NULL,error_at=NULL,failing_since=NULL,
            last_success_at=$7,lease_token=NULL,lease_until=NULL,due_at=now(),updated_at=now(),
            current_history_limited=CASE WHEN $8 THEN $9 ELSE current_history_limited END,
            history_from=CASE WHEN $10 THEN $11::timestamptz ELSE history_from END,
            history_requirement=CASE WHEN $10 THEN $12 ELSE history_requirement END
          WHERE tenant_id=$1 AND id=$2 AND lease_token=$3`,
          [
            tenantId,
            streamId,
            token,
            page.nextCursor,
            page.counts.records,
            page.total,
            page.now,
            history !== undefined,
            !!history,
            firstBackfillPage,
            history?.availableFrom ?? null,
            history?.requirement ?? null,
          ],
        );
        if (page.forget?.length)
          await tx.query(
            `DELETE FROM commerce_sync_items i
            USING jsonb_to_recordset($4::jsonb) AS e(resource text,"scopeKey" text,"externalId" text)
            WHERE i.tenant_id=$1 AND i.connection_id=$2 AND i.record_type=$3 AND i.missing_since IS NOT NULL
              AND i.resource=e.resource AND i.scope_key=e."scopeKey" AND i.external_id=e."externalId"`,
            [...scope, JSON.stringify(page.forget)],
          );
        if (!page.complete) {
          await foldItemCounts(tx, scope);

          return true;
        }
        if (
          current.record_type === 'products' ||
          current.record_type === 'orders'
        ) {
          // Fresh source coverage should not wait for the rule's periodic retry after an earlier incomplete read.
          await tx.query(
            `UPDATE commerce_auto_link_rules SET due_at=now() WHERE tenant_id=$1 AND enabled
             AND state<>'blocked' AND due_at>now() AND kind=$3
             AND (target_connection_id=$2 OR source_connection_id=$2)`,
            [
              tenantId,
              current.connection_id,
              current.record_type === 'products' ? 'sku' : 'order',
            ],
          );
        }
        const full =
          current.scan_since === null && current.scan_created_since === null;
        let missing: number | null = null;
        if (full) {
          // Only a complete scan can show that a record is gone. It is flagged; only customers that
          // stay missing are later forgotten, with their profiles.
          await tx.query(
            `UPDATE commerce_sync_items SET missing_since=COALESCE(missing_since,$5)
            WHERE tenant_id=$1 AND connection_id=$2 AND record_type=$3
              AND seen_scan_id IS DISTINCT FROM $4 AND last_seen_at < $6 AND status<>'retired'`,
            [...scope, current.scan_id, page.now, current.scan_started_at],
          );
          missing = Number(
            (
              await tx.query<{ count: string }>(
                `SELECT count(*) FROM commerce_sync_items WHERE tenant_id=$1 AND connection_id=$2
                AND record_type=$3 AND missing_since IS NOT NULL`,
                scope,
              )
            ).rows[0]!.count,
          );
        }
        await foldItemCounts(tx, scope);
        await tx.query(
          `UPDATE commerce_sync_runs SET outcome='completed',finished_at=$3,missing=$4
          WHERE tenant_id=$1 AND id=$2`,
          [tenantId, current.scan_id, page.now, missing],
        );
        if (current.suspended_scan) {
          const saved = current.suspended_scan;
          await tx.query(
            `UPDATE commerce_sync_streams SET scan=$4,scan_id=$5,cursor=$6,scan_started_at=$7,scan_since=$8,
            scan_created_since=$9,scan_waiting=$16,scan_pages=$10,scan_records=$11,scan_total=$12,suspended_scan=NULL,
            watermark=$13,last_complete_at=$14,live_due_at=$15,due_at=now() WHERE tenant_id=$1 AND id=$2 AND scan_id=$3`,
            [
              tenantId,
              streamId,
              current.scan_id,
              saved.kind,
              saved.id,
              saved.cursor,
              saved.startedAt,
              saved.since,
              saved.createdSince ?? null,
              saved.pages,
              saved.records,
              saved.total,
              current.scan_started_at,
              page.now,
              page.complete.nextDueAt,
              saved.waitingForExport ?? false,
            ],
          );

          return true;
        }
        if (current.scan === 'incremental' && current.phase === 'backfill') {
          await tx.query(
            `UPDATE commerce_sync_streams SET scan=NULL,scan_id=NULL,cursor=NULL,
            watermark=GREATEST(watermark,scan_started_at),last_complete_at=$3,live_due_at=$4,due_at=now()
            WHERE tenant_id=$1 AND id=$2`,
            [tenantId, streamId, page.now, page.complete.nextDueAt],
          );

          return true;
        }
        if (current.scan_created_since) {
          await tx.query(
            `UPDATE commerce_sync_streams SET scan=NULL,scan_id=NULL,cursor=NULL,scan_created_since=NULL,
            recent_history_completed_at=$3,watermark=GREATEST(watermark,scan_started_at),last_complete_at=$3,due_at=now(),
            live_due_at=$4,version=version+1 WHERE tenant_id=$1 AND id=$2`,
            [tenantId, streamId, page.now, page.complete.nextDueAt],
          );

          return true;
        }
        await tx.query(
          `UPDATE commerce_sync_streams SET scan=NULL,scan_id=NULL,cursor=NULL,scan_created_since=NULL,phase='incremental',
            watermark=GREATEST(watermark,scan_started_at),last_complete_at=$3,
            last_full_scan_at=CASE WHEN $4 THEN scan_started_at ELSE last_full_scan_at END,
            backfill_completed_at=CASE WHEN scan='backfill' THEN $3 ELSE backfill_completed_at END,
            recent_history_completed_at=COALESCE(recent_history_completed_at,$3),live_due_at=$5,
            due_at=$5,version=version+1
          WHERE tenant_id=$1 AND id=$2`,
          [tenantId, streamId, page.now, full, page.complete.nextDueAt],
        );

        return true;
      });
    },
    async failPage(tenantId, streamId, token, failure) {
      await db.transaction(tenantId, async (tx) => {
        const current = await lockStream(tx, tenantId, streamId, token);
        if (!current) return;
        await tx.query(
          `UPDATE commerce_sync_streams SET attempts=attempts+1,error_code=$4,error_message=$5,error_at=now(),
            failing_since=COALESCE(failing_since,now()),
            due_at=$6,lease_token=NULL,lease_until=NULL,blocked=COALESCE($8,blocked),
            cursor=CASE WHEN $7 THEN NULL ELSE cursor END,scan_pages=CASE WHEN $7 THEN 0 ELSE scan_pages END,
            scan_records=CASE WHEN $7 THEN 0 ELSE scan_records END,version=version+1,updated_at=now()
          WHERE tenant_id=$1 AND id=$2 AND lease_token=$3`,
          [
            tenantId,
            streamId,
            token,
            failure.code,
            failure.message,
            failure.dueAt,
            failure.restart,
            failure.block,
          ],
        );
        if (current.scan_id)
          await tx.query(
            'UPDATE commerce_sync_runs SET errors=errors+1 WHERE tenant_id=$1 AND id=$2',
            [tenantId, current.scan_id],
          );
      });
    },
    linkCoverage: (tenantId, excluded) =>
      db.transaction(
        tenantId,
        async (tx) => {
          const result = await tx.query<{
            kind: 'sku' | 'order';
            total: number;
            linked: number;
          }>(
            `WITH records AS (
         SELECT DISTINCT 'sku' AS kind,k.sku_id AS id,k.connection_id FROM inventory_product_skus k
          WHERE k.tenant_id=$1 AND k.connection_id<>ALL($2::uuid[])
         UNION ALL SELECT 'order',o.entity_id,o.connection_id FROM orders_list o
          WHERE o.tenant_id=$1 AND NOT o.deleted AND o.connection_id<>ALL($2::uuid[])
        ), identities AS (
         SELECT kind,id,count(DISTINCT connection_id)::int AS sources FROM records GROUP BY kind,id
        ) SELECT kind,COALESCE(sum(sources),0)::int AS total,
         COALESCE(sum(sources) FILTER (WHERE sources>1),0)::int AS linked FROM identities GROUP BY kind`,
            [tenantId, excluded],
          );

          const count = (kind: 'sku' | 'order') => {
            const row = result.rows.find((row) => row.kind === kind);

            return { total: row?.total ?? 0, linked: row?.linked ?? 0 };
          };

          return { sku: count('sku'), order: count('order') };
        },
        { readOnlySnapshot: true },
      ),
    async overview(tenantId) {
      return db.transaction(
        tenantId,
        async (tx) => {
          const streams = (
            await tx.query<StreamRow>(
              'SELECT * FROM commerce_sync_streams WHERE tenant_id=$1 ORDER BY connection_id,record_type',
              [tenantId],
            )
          ).rows.map(stream);
          const coverage = (
            await tx.query<{
              stream_id: string;
              total: string;
              current: string;
              pending: string;
              failed: string;
              missing: string;
              retired: string;
              oldest: Date | null;
              newest: Date | null;
              problems: string[] | null;
            }>(
              // Counts come from the ledger's count changes, written with each ledger change, so
              // they are as current as the ledger in this snapshot. Creation dates use the
              // stream's creation-date index; problems use the partial attention and missing indexes.
              `SELECT s.id AS stream_id,COALESCE(c.total,0) AS total,COALESCE(c.current,0) AS current,
                COALESCE(c.pending,0) AS pending,COALESCE(c.failed,0) AS failed,
                COALESCE(c.retired,0) AS retired,COALESCE(c.missing,0) AS missing,
                (SELECT min(i.source_created_at) FROM commerce_sync_items i WHERE i.tenant_id=s.tenant_id
                  AND i.connection_id=s.connection_id AND i.record_type=s.record_type) AS oldest,
                (SELECT max(i.source_created_at) FROM commerce_sync_items i WHERE i.tenant_id=s.tenant_id
                  AND i.connection_id=s.connection_id AND i.record_type=s.record_type) AS newest,
                (SELECT array_agg(p.problem) FROM (SELECT DISTINCT x.problem FROM commerce_sync_items x
                  WHERE x.tenant_id=s.tenant_id AND x.connection_id=s.connection_id AND x.record_type=s.record_type
                  AND (x.status IN ('pending','failed') OR (x.missing_since IS NOT NULL AND x.status<>'retired'))
                  AND x.problem IS NOT NULL ORDER BY x.problem LIMIT 5) p) AS problems
              FROM commerce_sync_streams s
              LEFT JOIN (SELECT connection_id,record_type,sum(total) AS total,sum(current) AS current,
                  sum(pending) AS pending,sum(failed) AS failed,sum(retired) AS retired,sum(missing) AS missing
                FROM commerce_sync_item_counts WHERE tenant_id=$1 GROUP BY connection_id,record_type) c
                ON c.connection_id=s.connection_id AND c.record_type=s.record_type
              WHERE s.tenant_id=$1`,
              [tenantId],
            )
          ).rows.map((row): StreamCoverage => ({
            streamId: row.stream_id,
            total: Number(row.total),
            current: Number(row.current),
            pending: Number(row.pending),
            failed: Number(row.failed),
            missing: Number(row.missing),
            retired: Number(row.retired),
            oldest: iso(row.oldest),
            newest: iso(row.newest),
            problems: row.problems ?? [],
          }));
          const runs = (
            await tx.query<RunRow>(
              `SELECT r.*,s.connection_id,s.record_type FROM commerce_sync_runs r
              JOIN commerce_sync_streams s ON s.tenant_id=r.tenant_id AND s.id=r.stream_id
              WHERE r.tenant_id=$1 ORDER BY r.started_at DESC,r.id LIMIT 30`,
              [tenantId],
            )
          ).rows.map(run);

          return { streams, coverage, runs };
        },
        { readOnlySnapshot: true },
      );
    },
    async runs(tenantId, streamId, limit, before) {
      return db.transaction(
        tenantId,
        async (tx) => {
          const owner = await tx.query<{ connection_id: string }>(
            'SELECT connection_id FROM commerce_sync_streams WHERE tenant_id=$1 AND id=$2',
            [tenantId, streamId],
          );
          const connectionId = owner.rows[0]?.connection_id;
          if (!connectionId) return null;
          // An unknown `before` run compares as NULL, so the page is empty rather than the start.
          const runs = await tx.query<RunRow>(
            `SELECT r.*,s.connection_id,s.record_type FROM commerce_sync_runs r
            JOIN commerce_sync_streams s ON s.tenant_id=r.tenant_id AND s.id=r.stream_id
            WHERE r.tenant_id=$1 AND r.stream_id=$2
              AND ($4::uuid IS NULL OR (r.started_at,r.id) < (SELECT b.started_at,b.id FROM commerce_sync_runs b
                WHERE b.tenant_id=$1 AND b.stream_id=$2 AND b.id=$4))
            ORDER BY r.started_at DESC,r.id DESC LIMIT $3`,
            [tenantId, streamId, limit, before ?? null],
          );

          return { connectionId, runs: runs.rows.map(run) };
        },
        { readOnlySnapshot: true },
      );
    },
    async records(tenantId, streamId, state, limit, after) {
      return db.transaction(
        tenantId,
        async (tx) => {
          const owner = await tx.query<{
            connection_id: string;
            record_type: RecordType;
          }>(
            'SELECT connection_id,record_type FROM commerce_sync_streams WHERE tenant_id=$1 AND id=$2',
            [tenantId, streamId],
          );
          const stream = owner.rows[0];
          if (!stream) return null;
          const rows = await tx.query<{
            resource: ItemKey['resource'];
            scope_key: string;
            external_id: string;
            problem: string | null;
            entity_id: string | null;
            source_created_at: Date | null;
            last_seen_at: Date;
            missing_since: Date | null;
          }>(
            `SELECT resource,scope_key,external_id,problem,entity_id,source_created_at,last_seen_at,missing_since
            FROM commerce_sync_items
            WHERE tenant_id=$1 AND connection_id=$2 AND record_type=$3 AND ${recordStates[state]}
              AND ($5::text IS NULL OR (resource,scope_key,external_id) > ($5,$6,$7))
            ORDER BY resource,scope_key,external_id LIMIT $4`,
            [
              tenantId,
              stream.connection_id,
              stream.record_type,
              limit,
              after?.resource ?? null,
              after?.scopeKey ?? null,
              after?.externalId ?? null,
            ],
          );

          return {
            connectionId: stream.connection_id,
            records: rows.rows.map((row): SyncRecordProblem => ({
              resource: row.resource,
              scopeKey: row.scope_key,
              externalId: row.external_id,
              state,
              problem: row.problem,
              entityId: row.entity_id,
              sourceCreatedAt: iso(row.source_created_at),
              lastSeenAt: row.last_seen_at.toISOString(),
              missingSince: iso(row.missing_since),
            })),
          };
        },
        { readOnlySnapshot: true },
      );
    },
    async command(tenantId, streamId, command, principalId) {
      return db.transaction(tenantId, async (tx) => {
        const current = (
          await tx.query<StreamRow>(
            'SELECT * FROM commerce_sync_streams WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
            [tenantId, streamId],
          )
        ).rows[0];
        if (!current) return false;
        await applyCommand(tx, current, command, principalId);

        return true;
      });
    },
    async commandConnection(tenantId, connectionId, command, principalId) {
      return db.transaction(tenantId, async (tx) => {
        const streams = (
          await tx.query<StreamRow>(
            'SELECT * FROM commerce_sync_streams WHERE tenant_id=$1 AND connection_id=$2 ORDER BY id FOR UPDATE',
            [tenantId, connectionId],
          )
        ).rows.filter((row) =>
          command === 'pause'
            ? !row.paused
            : command === 'resume'
              ? row.paused || row.blocked === 'principal_unavailable'
              : !row.paused && !row.blocked,
        );
        for (const row of streams)
          await applyCommand(tx, row, { kind: command }, principalId);

        return streams.map((row) => row.id);
      });
    },
    async requestLink(tenantId, request) {
      return db.transaction(tenantId, async (tx) =>
        link(
          (
            await tx.query<LinkRow>(
              `INSERT INTO commerce_identity_links(tenant_id,id,kind,operation,entity_id,other_id,connection_id,reason,requested_by,state)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'requested') RETURNING *`,
              [
                tenantId,
                request.id,
                request.kind,
                request.operation,
                request.entityId,
                request.otherId,
                request.connectionId,
                request.reason,
                request.requestedBy,
              ],
            )
          ).rows[0]!,
        ),
      );
    },
    async linkRequests(tenantId, entityId) {
      return db.transaction(tenantId, async (tx) =>
        (
          await tx.query<LinkRow>(
            `SELECT * FROM commerce_identity_links WHERE tenant_id=$1 AND (entity_id=$2 OR other_id=$2)
            ORDER BY created_at DESC LIMIT 10`,
            [tenantId, entityId],
          )
        ).rows.map(link),
      );
    },
    async linkRequest(tenantId, id) {
      return db.transaction(tenantId, async (tx) => {
        const row = (
          await tx.query<LinkRow>(
            'SELECT * FROM commerce_identity_links WHERE tenant_id=$1 AND id=$2',
            [tenantId, id],
          )
        ).rows[0];

        return row ? link(row) : null;
      });
    },
    async claimLink(tenantId, leaseMs) {
      return db.transaction(tenantId, async (tx) => {
        const row = (
          await tx.query<LinkRow>(
            `UPDATE commerce_identity_links l SET state='running',attempts=attempts+1,
              lease_until=now()+($2::integer*interval '1 millisecond')
            WHERE l.tenant_id=$1 AND l.id=(SELECT id FROM commerce_identity_links WHERE tenant_id=$1
              AND (state='requested' OR (state='running' AND lease_until < now()))
              ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
            RETURNING l.*`,
            [tenantId, leaseMs],
          )
        ).rows[0];

        return row ? link(row) : null;
      });
    },
    async finishLink(tenantId, id, result) {
      await db.transaction(tenantId, async (tx) => {
        if (result.state === 'completed')
          await tx.query(
            `UPDATE commerce_sync_items item SET entity_id=m.canonical_id
            FROM connector_source_mappings m WHERE item.tenant_id=$1 AND m.tenant_id=item.tenant_id
             AND m.connection_id=item.connection_id AND m.resource=item.resource AND m.scope_key=item.scope_key
             AND m.external_id=item.external_id AND item.resource IN ('order','fulfillment','return','refund')
             AND item.entity_id IS DISTINCT FROM m.canonical_id
             AND EXISTS (SELECT 1 FROM commerce_identity_links WHERE tenant_id=$1 AND id=$2 AND kind='order')`,
            [tenantId, id],
          );
        await tx.query(
          `UPDATE commerce_identity_links SET state=$3,message=$4,lease_until=NULL,
            completed_at=CASE WHEN $3 IN ('completed','failed') THEN now() ELSE NULL END
          WHERE tenant_id=$1 AND id=$2`,
          [tenantId, id, result.state, result.message],
        );
      });
    },
  };
}
