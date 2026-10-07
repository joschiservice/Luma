import type { CanonicalSnapshot, RefundData, ReturnData } from '@luma/orders';
import type { SqlTransaction } from '@luma/platform';

import type {
  ReturnDetail,
  ReturnListItem,
} from '../../application/returns.js';
import { resolveOrderEntity } from '../orders/identity-references.js';
import { itemColumns, readReturnSources } from './list.js';

type Current = { entityId: string; document: CanonicalSnapshot };

async function readItem(tx: SqlTransaction, tenantId: string, id: string) {
  const result = await tx.query<ReturnListItem>(
    `SELECT ${itemColumns} FROM orders_returns r WHERE r.tenant_id=$1 AND r.entity_id=$2
     ORDER BY r.connection_id LIMIT 1`,
    [tenantId, id],
  );

  return result.rows[0] ?? null;
}

/**
 * Reads one return with its order lines, refunds, related returns and observed snapshots. A
 * refund that settles a return resolves to that return. Returns null when the tenant has no
 * such record.
 */
export async function readReturnDetail(
  tx: SqlTransaction,
  tenantId: string,
  id: string,
): Promise<Omit<ReturnDetail, 'asOf' | 'hidden'> | null> {
  id = await resolveOrderEntity(tx, tenantId, id);
  let item = await readItem(tx, tenantId, id);
  if (!item) {
    const settled = await tx.query<{ returnId: string | null }>(
      `SELECT s.document->'data'->>'returnId' AS "returnId" FROM orders_projections p
       JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
       WHERE p.tenant_id=$1 AND p.entity_id=$2 AND s.kind='refund' LIMIT 1`,
      [tenantId, id],
    );
    const returnId = settled.rows[0]?.returnId;
    if (returnId) item = await readItem(tx, tenantId, returnId);
  }
  if (!item) return null;
  const current = (
    await tx.query<Current>(
      `SELECT p.entity_id AS "entityId",s.document FROM orders_snapshots s
       JOIN orders_projections p ON p.tenant_id=s.tenant_id AND p.entity_id=s.entity_id
        AND p.connection_id=s.connection_id AND p.snapshot_id=s.id
       WHERE s.tenant_id=$1 AND s.order_id=$2 AND s.connection_id=$3 AND s.kind IN ('return','refund')`,
      [tenantId, item.order.id, item.connectionId],
    )
  ).rows;
  const own = current.find((row) => row.entityId === item.id)?.document;
  if (!own) return null;
  const refunds = current.filter(
    (row) =>
      row.document.data.type === 'refund' &&
      (item.kind === 'refund'
        ? row.entityId === item.id
        : row.document.data.returnId === item.id),
  );
  const order = (
    await tx.query<{ document: CanonicalSnapshot; externalId: string | null }>(
      `SELECT s.document,(SELECT m.external_id FROM connector_source_mappings m WHERE m.tenant_id=p.tenant_id
        AND m.resource='order' AND m.canonical_id=p.entity_id AND m.connection_id=p.connection_id
        ORDER BY m.external_id LIMIT 1) AS "externalId"
       FROM orders_projections p JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
       WHERE p.tenant_id=$1 AND p.entity_id=$2 AND p.connection_id=$3`,
      [tenantId, item.order.id, item.connectionId],
    )
  ).rows[0];
  const orderData =
    order?.document.data.type === 'order' ? order.document.data : null;
  const orderLine = (id: string | null) =>
    orderData?.lines.find((line) => line.id === id);
  const refundIds = refunds.map((row) => row.entityId);
  const externalIds = new Map(
    (
      await tx.query<{ id: string; externalId: string }>(
        `SELECT canonical_id AS id,min(external_id) AS "externalId" FROM connector_source_mappings
         WHERE tenant_id=$1 AND resource='refund' AND canonical_id=ANY($2::uuid[]) AND connection_id=$3
         GROUP BY canonical_id`,
        [tenantId, refundIds, item.connectionId],
      )
    ).rows.map((row) => [row.id, row.externalId]),
  );
  const related = await tx.query<ReturnListItem>(
    `SELECT ${itemColumns} FROM orders_returns r WHERE r.tenant_id=$1 AND r.order_id=$2 AND r.entity_id<>$3
     ORDER BY r.requested_key DESC,r.entity_id LIMIT 20`,
    [tenantId, item.order.id, item.id],
  );
  const history = await tx.query<
    ReturnDetail['history']['entries'][number] & {
      observedAt: Date;
      sourceUpdatedAt: Date | null;
    }
  >(
    `SELECT s.id AS "snapshotId",s.kind AS "entityKind",s.entity_id AS "entityId",s.status,
      (s.document->>'deleted')::boolean AS deleted,
      EXISTS (SELECT 1 FROM orders_projections p WHERE p.tenant_id=s.tenant_id AND p.entity_id=s.entity_id
       AND p.connection_id=s.connection_id AND p.snapshot_id=s.id) AS current,
      s.observed_at AS "observedAt",s.source_updated_at AS "sourceUpdatedAt"
     FROM orders_snapshots s WHERE s.tenant_id=$1 AND s.entity_id=ANY($2::uuid[])
     ORDER BY s.observed_at DESC,s.created_at DESC,s.id DESC LIMIT 51`,
    [tenantId, [item.id, ...refundIds]],
  );
  const returned = own.data.type === 'return' ? own.data : null;
  const sources = await readReturnSources(tx, tenantId);

  return {
    item,
    source:
      sources.find((source) => source.connectionId === item.connectionId) ??
      null,
    order: order
      ? {
          id: item.order.id,
          displayNumber: orderData?.displayNumber ?? null,
          externalId: order.externalId,
          status: orderData?.status ?? 'unknown',
          paymentStatus: orderData?.paymentStatus ?? 'unknown',
          placedAt: orderData?.placedAt ?? null,
          total: orderData?.total ?? null,
        }
      : null,
    lines: (returned?.lines ?? []).map((line) => {
      const source = orderLine(line.orderLineId);

      return {
        orderLineId: line.orderLineId,
        title: source?.title ?? null,
        skuId: source?.skuId ?? null,
        skuCode: source?.skuCode ?? null,
        quantity: line.quantity,
        unit: line.unit,
        reason: line.reason,
        received: line.receivedQuantity,
        restocked: line.restockedQuantity,
        refunded: line.refundedQuantity,
        value: line.value,
      };
    }),
    timeline: timeline(returned),
    refunds: refunds
      .map((row) => ({ row, data: row.document.data as RefundData }))
      .sort((a, b) =>
        (a.data.createdAt ?? '').localeCompare(b.data.createdAt ?? ''),
      )
      .map(({ row, data }) => ({
        id: row.entityId,
        externalId: externalIds.get(row.entityId) ?? null,
        createdAt: data.createdAt,
        total: data.total,
        lines: data.lines.map((line) => ({
          orderLineId: line.orderLineId,
          title: orderLine(line.orderLineId)?.title ?? null,
          quantity: line.quantity,
          unit: line.unit,
          restock: line.restock,
          restocked: line.restocked,
        })),
        transactions: data.transactions,
        observedAt: row.document.observedAt,
        sourceUpdatedAt: row.document.sourceUpdatedAt,
      })),
    related: related.rows,
    history: {
      entries: history.rows.slice(0, 50).map((row) => ({
        ...row,
        observedAt: row.observedAt.toISOString(),
        sourceUpdatedAt: row.sourceUpdatedAt?.toISOString() ?? null,
      })),
      truncated: history.rows.length > 50,
    },
  };
}

function timeline(value: ReturnData | null): ReturnDetail['timeline'] {
  return {
    requestedAt: value?.requestedAt ?? null,
    approvedAt: value?.approvedAt ?? null,
    receivedAt: value?.receivedAt ?? null,
    closedAt: value?.closedAt ?? null,
    declineReason: value?.declineReason ?? null,
  };
}
