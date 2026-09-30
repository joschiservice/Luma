import { stageGroups } from '@luma/orders';
import type { SqlTransaction } from '@luma/platform';

import type {
  ReturnListItem,
  ReturnQuery,
  ReturnSource,
  ReturnStage,
  ReturnView,
} from '../../application/returns.js';

const iso = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const decimal = (column: string) => `trim_scale(${column})::text`;

/** Selects one `orders_returns` row, aliased `r`, in the shape of a list item. */
export const itemColumns = `r.entity_id AS id,r.kind,r.connection_id AS "connectionId",
 (SELECT m.external_id FROM connector_source_mappings m WHERE m.tenant_id=r.tenant_id AND m.resource=r.kind
  AND m.canonical_id=r.entity_id AND m.connection_id=r.connection_id ORDER BY m.external_id LIMIT 1) AS "externalId",
 r.name,jsonb_build_object('id',r.order_id,'displayNumber',r.order_number) AS "order",r.status,r.stage,
 r.stage_group AS "group",
 jsonb_build_object('state',r.refund_state,'currency',r.currency,'refunded',${decimal('r.refunded_amount')},
  'pending',${decimal('r.pending_amount')},'failedAttempts',r.failed_attempts) AS refund,
 ${decimal('r.quantity')} AS quantity,${decimal('r.received')} AS received,
 ${decimal('r.refunded_units')} AS "refundedUnits",
 CASE WHEN r.value_amount IS NULL THEN NULL
  ELSE jsonb_build_object('amount',${decimal('r.value_amount')},'currency',r.value_currency) END AS value,
 r.reasons,${iso('r.requested_at')} AS "requestedAt",${iso('r.activity_at')} AS "activityAt",
 ${iso('r.observed_at')} AS "observedAt",${iso('r.source_updated_at')} AS "sourceUpdatedAt",r.deleted`;

/** Position of the last row on a page in the requested order. */
export interface ReturnPosition {
  key: string;
  id: string;
}

/**
 * Lists up to `limit + 1` returns for the filters after `after`, with counts per view and
 * stage. Removed records are excluded. Search matches the return name, order number, reasons
 * and source IDs of the return, refund or order.
 */
export async function readReturns(
  tx: SqlTransaction,
  tenantId: string,
  query: ReturnQuery,
  after: ReturnPosition | null,
) {
  const key = query.sort === 'activity' ? 'r.activity_at' : 'r.requested_key';
  const q = query.q.trim();
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const scoped = `WITH scoped AS (
    SELECT r.* FROM orders_returns r
    WHERE r.tenant_id=$1 AND NOT r.deleted AND ($2::uuid IS NULL OR r.connection_id=$2)
     AND ($3='' OR r.name ILIKE $4 OR r.order_number ILIKE $4 OR r.entity_id::text=lower($3)
      OR r.order_id::text=lower($3) OR EXISTS (SELECT 1 FROM unnest(r.reasons) reason WHERE reason ILIKE $4)
      OR EXISTS (SELECT 1 FROM connector_source_mappings m WHERE m.tenant_id=$1
       AND m.resource IN ('return','refund','order') AND m.canonical_id IN (r.entity_id,r.order_id)
       AND m.connection_id=r.connection_id AND m.external_id ILIKE $4))
  )`;
  const filters = [query.connectionId ?? null, q, pattern];
  const counts = await tx.query<{ stage: ReturnStage; count: number }>(
    `${scoped} SELECT stage,count(*)::int AS count FROM scoped GROUP BY stage`,
    [tenantId, ...filters],
  );
  const direction = query.direction === 'asc' ? 'ASC' : 'DESC';
  const rows = await tx.query<ReturnListItem & { position: string }>(
    `${scoped} SELECT ${itemColumns},
      to_char(${key} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS position FROM scoped r
     WHERE ($5='all' OR r.stage_group=$5) AND ($6::text IS NULL OR r.stage=$6)
      AND ($7::timestamptz IS NULL OR (${key},r.entity_id) ${direction === 'ASC' ? '>' : '<'} ($7,$8::uuid))
     ORDER BY ${key} ${direction},r.entity_id ${direction} LIMIT $9`,
    [
      tenantId,
      ...filters,
      query.view,
      query.stage ?? null,
      after?.key ?? null,
      after?.id ?? null,
      query.limit + 1,
    ],
  );
  const stages: Record<ReturnStage, number> = {
    requested: 0,
    awaiting_items: 0,
    awaiting_refund: 0,
    refund_pending: 0,
    refund_failed: 0,
    ready_to_close: 0,
    closed: 0,
    declined: 0,
    cancelled: 0,
    refunded: 0,
    refund_recorded: 0,
    unknown: 0,
  };
  const byView: Record<ReturnView, number> = {
    action: 0,
    waiting: 0,
    done: 0,
    all: 0,
  };
  for (const row of counts.rows) {
    stages[row.stage] = row.count;
    byView.all += row.count;
    byView[stageGroups[row.stage]] += row.count;
  }

  return {
    rows: rows.rows.map(({ position, ...item }) => ({ position, item })),
    counts: { views: byView, stages },
  };
}

/**
 * Lists commerce connections with whether they share returns, how many Luma holds and the
 * state of their returns sync. Connections that read orders are included even without returns,
 * so missing access is visible.
 */
export async function readReturnSources(tx: SqlTransaction, tenantId: string) {
  const result = await tx.query<ReturnSource>(
    `WITH counted AS (SELECT connection_id,count(*)::int AS records FROM orders_returns
      WHERE tenant_id=$1 AND NOT deleted GROUP BY connection_id)
     SELECT c.id AS "connectionId",COALESCE(c.document->>'label',c.document->'target'->>'kind','Connected source') AS label,
      COALESCE(c.document->>'provider',c.document->'target'->>'kind') AS system,c.document->>'appId' AS "appId",
      COALESCE(c.document->>'status','unknown') AS status,
      CASE WHEN c.document->'granted' ? 'returns.read' THEN 'granted'
       WHEN c.document->'permissions' ? 'returns.read' THEN 'not_granted' ELSE 'not_requested' END AS access,
      COALESCE(n.records,0) AS records,COALESCE(st.phase='backfill',false) AS importing,
      ${iso('st.last_full_scan_at')} AS "fullReadAt",${iso('st.last_success_at')} AS "lastReadAt",
      st.error_code IS NOT NULL AS failing
     FROM connector_installations c
     LEFT JOIN counted n ON n.connection_id=c.id
     LEFT JOIN commerce_sync_streams st ON st.tenant_id=c.tenant_id AND st.connection_id=c.id AND st.record_type='returns'
     WHERE c.tenant_id=$1 AND (n.connection_id IS NOT NULL OR (c.document->'permissions' ? 'orders.read'
      AND c.document->>'status' NOT IN ('disconnected','revoked')))
     ORDER BY label,c.id`,
    [tenantId],
  );

  return result.rows;
}
