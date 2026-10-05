import type { SqlTransaction, TenantDatabase } from '@luma/platform';

import type {
  LinkRequest,
  StreamCoverage,
  SyncConnection,
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
            pages: row.scan_pages,
            records: row.scan_records,
            total: row.scan_total,
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

const recordTypeCase = `CASE cap ${Object.entries(recordCapabilities)
  .map(([type, capability]) => `WHEN '${capability}' THEN '${type}'`)
  .join(' ')} END`;

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
            WHERE tenant_id=$1 AND consumed_at IS NULL RETURNING connection_id,capabilities,received_at
          ), latest AS (
            SELECT connection_id,${recordTypeCase} AS record_type,min(received_at) AS received_at
            FROM hints CROSS JOIN LATERAL unnest(capabilities) cap GROUP BY 1,2
          )
          UPDATE commerce_sync_streams s SET hint_at=LEAST(COALESCE(s.hint_at,'infinity'),
            l.received_at+($2::integer*interval '1 millisecond')),updated_at=now()
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
    async claim(tenantId, token, leaseMs) {
      return db.transaction(tenantId, async (tx) => {
        const row = (
          await tx.query<StreamRow>(
            `WITH candidate AS (
              SELECT s.id FROM commerce_sync_streams s
              WHERE s.tenant_id=$1 AND NOT s.paused AND s.blocked IS NULL
                AND (s.lease_until IS NULL OR s.lease_until < now())
                AND (s.due_at <= now() OR s.hint_at <= now())
                -- Fulfillments and returns refer to orders, so their history waits for the order history.
                AND NOT (s.record_type IN ('fulfillments','returns') AND s.phase='backfill' AND EXISTS (
                  SELECT 1 FROM commerce_sync_streams o WHERE o.tenant_id=s.tenant_id
                  AND o.connection_id=s.connection_id AND o.record_type='orders'
                  AND o.phase='backfill' AND o.blocked IS NULL))
              ORDER BY LEAST(s.due_at,s.hint_at) NULLS LAST,s.id
              LIMIT 1 FOR UPDATE SKIP LOCKED
            )
            UPDATE commerce_sync_streams s SET lease_token=$2,
              lease_until=now()+($3::integer*interval '1 millisecond'),updated_at=now()
            FROM candidate c WHERE s.tenant_id=$1 AND s.id=c.id RETURNING s.*`,
            [tenantId, token, leaseMs],
          )
        ).rows[0];

        return row ? stream(row) : null;
      });
    },
    async startScan(tenantId, streamId, token, run) {
      return db.transaction(tenantId, async (tx) => {
        const row = (
          await tx.query<StreamRow>(
            `UPDATE commerce_sync_streams SET scan=$4,scan_id=$5,cursor=NULL,scan_started_at=$6,scan_since=$7,
              scan_pages=0,scan_records=0,scan_total=NULL,
              full_requested=CASE WHEN $8 THEN false ELSE full_requested END,
              backfill_started_at=CASE WHEN $4='backfill' THEN $6 ELSE backfill_started_at END,
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
            ],
          )
        ).rows[0];
        if (!row) return null;
        await tx.query(
          `INSERT INTO commerce_sync_runs(tenant_id,id,stream_id,kind,trigger,since,full_scan,started_at,outcome)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running')`,
          [
            tenantId,
            run.id,
            streamId,
            run.plan.kind,
            run.plan.trigger,
            run.plan.since,
            run.fullScan,
            run.now,
          ],
        );

        return stream(row);
      });
    },
    async ledger(tenantId, connectionId, recordType, keys) {
      const found = new Map<
        string,
        { digest: string; status: 'current' | 'pending' | 'failed' }
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
              status: 'current' | 'pending' | 'failed';
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
    async commitPage(tenantId, streamId, token, page) {
      return db.transaction(tenantId, async (tx) => {
        const current = await lockStream(tx, tenantId, streamId, token);
        if (!current?.scan_id || !current.scan || !current.scan_started_at)
          return false;
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
          `UPDATE commerce_sync_streams SET cursor=$4,scan_pages=scan_pages+1,scan_records=scan_records+$5,
            scan_total=COALESCE($6,scan_total),attempts=0,error_code=NULL,error_message=NULL,error_at=NULL,failing_since=NULL,
            last_success_at=$7,lease_token=NULL,lease_until=NULL,due_at=$7,updated_at=now(),
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
        if (!page.complete) return true;
        const full = current.scan_since === null;
        let missing: number | null = null;
        if (full) {
          // Only a complete scan can show that a record is gone; it is flagged, never deleted.
          await tx.query(
            `UPDATE commerce_sync_items SET missing_since=COALESCE(missing_since,$5)
            WHERE tenant_id=$1 AND connection_id=$2 AND record_type=$3
              AND seen_scan_id IS DISTINCT FROM $4 AND first_seen_at < $6`,
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
        await tx.query(
          `UPDATE commerce_sync_runs SET outcome='completed',finished_at=$3,missing=$4
          WHERE tenant_id=$1 AND id=$2`,
          [tenantId, current.scan_id, page.now, missing],
        );
        await tx.query(
          `UPDATE commerce_sync_streams SET scan=NULL,scan_id=NULL,cursor=NULL,phase='incremental',
            watermark=scan_started_at,last_complete_at=$3,
            last_full_scan_at=CASE WHEN $4 THEN scan_started_at ELSE last_full_scan_at END,
            backfill_completed_at=CASE WHEN scan='backfill' THEN $3 ELSE backfill_completed_at END,
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
              oldest: Date | null;
              newest: Date | null;
              problems: string[] | null;
            }>(
              `SELECT s.id AS stream_id,count(i.external_id) AS total,
                count(*) FILTER (WHERE i.status='current') AS current,
                count(*) FILTER (WHERE i.status='pending') AS pending,
                count(*) FILTER (WHERE i.status='failed') AS failed,
                count(*) FILTER (WHERE i.missing_since IS NOT NULL) AS missing,
                min(i.source_created_at) AS oldest,max(i.source_created_at) AS newest,
                (SELECT array_agg(p.problem) FROM (SELECT DISTINCT x.problem FROM commerce_sync_items x
                  WHERE x.tenant_id=s.tenant_id AND x.connection_id=s.connection_id AND x.record_type=s.record_type
                  AND x.status<>'current' AND x.problem IS NOT NULL ORDER BY x.problem LIMIT 5) p) AS problems
              FROM commerce_sync_streams s
              LEFT JOIN commerce_sync_items i ON i.tenant_id=s.tenant_id AND i.connection_id=s.connection_id
                AND i.record_type=s.record_type
              WHERE s.tenant_id=$1 GROUP BY s.tenant_id,s.id,s.connection_id,s.record_type`,
              [tenantId],
            )
          ).rows.map((row): StreamCoverage => ({
            streamId: row.stream_id,
            total: Number(row.total),
            current: Number(row.current),
            pending: Number(row.pending),
            failed: Number(row.failed),
            missing: Number(row.missing),
            oldest: iso(row.oldest),
            newest: iso(row.newest),
            problems: row.problems ?? [],
          }));
          const runs = (
            await tx.query<{
              id: string;
              stream_id: string;
              connection_id: string;
              record_type: RecordType;
              kind: SyncRun['kind'];
              trigger: SyncRun['trigger'];
              since: Date | null;
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
            }>(
              `SELECT r.*,s.connection_id,s.record_type FROM commerce_sync_runs r
              JOIN commerce_sync_streams s ON s.tenant_id=r.tenant_id AND s.id=r.stream_id
              WHERE r.tenant_id=$1 ORDER BY r.started_at DESC,r.id LIMIT 30`,
              [tenantId],
            )
          ).rows.map((row): SyncRun => ({
            id: row.id,
            streamId: row.stream_id,
            connectionId: row.connection_id,
            recordType: row.record_type,
            kind: row.kind,
            trigger: row.trigger,
            since: iso(row.since),
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
          }));

          return { streams, coverage, runs };
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
        const values = [tenantId, streamId, principalId];
        if (command.kind === 'pause')
          await tx.query(
            'UPDATE commerce_sync_streams SET paused=true,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2',
            values.slice(0, 2),
          );
        else if (command.kind === 'reimport') {
          if (current.scan_id)
            await tx.query(
              `UPDATE commerce_sync_runs SET outcome='cancelled',finished_at=now()
              WHERE tenant_id=$1 AND id=$2 AND outcome='running'`,
              [tenantId, current.scan_id],
            );
          await tx.query(
            `UPDATE commerce_sync_streams SET phase='backfill',scan=NULL,scan_id=NULL,cursor=NULL,scan_started_at=NULL,
              scan_since=NULL,scan_pages=0,scan_records=0,scan_total=NULL,full_requested=true,paused=false,
              principal_id=$3,blocked=CASE WHEN blocked='principal_unavailable' THEN NULL ELSE blocked END,
              lease_token=NULL,lease_until=NULL,due_at=now(),attempts=0,error_code=NULL,error_message=NULL,
              error_at=NULL,failing_since=NULL,version=version+1,updated_at=now()
            WHERE tenant_id=$1 AND id=$2`,
            values,
          );
        } else
          await tx.query(
            `UPDATE commerce_sync_streams SET paused=false,principal_id=$3,
              blocked=CASE WHEN blocked='principal_unavailable' THEN NULL ELSE blocked END,
              full_requested=full_requested OR $4,due_at=LEAST(COALESCE(due_at,now()),now()),
              version=version+1,updated_at=now()
            WHERE tenant_id=$1 AND id=$2`,
            [...values, command.kind === 'reconcile'],
          );

        return true;
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
