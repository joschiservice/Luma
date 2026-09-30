import type { SqlTransaction } from '@luma/platform';

import type {
  CanonicalSnapshot,
  RefundData,
  ReturnData,
} from '../application/projections.js';
import {
  refundProgress,
  type ReturnProgress,
  returnProgress,
} from '../domain/returns.js';

type Current = {
  entityId: string;
  connectionId: string;
  snapshotId: string;
  document: CanonicalSnapshot;
};

const latest = (values: (string | null | undefined)[]) =>
  values
    .filter((value): value is string => !!value)
    .reduce<string | null>(
      (max, value) =>
        !max || Date.parse(value) > Date.parse(max) ? value : max,
      null,
    );

/**
 * Rebuilds one order's rows in `orders_returns` from its current return and refund
 * projections. Refunds linked to a current return of the same source are folded into that
 * return's row; other refunds get their own row. Call it in the projection transaction.
 */
export async function refreshReturnList(
  tx: SqlTransaction,
  tenantId: string,
  orderId: string,
) {
  const current = (
    await tx.query<Current>(
      `SELECT p.entity_id AS "entityId",p.connection_id AS "connectionId",s.id AS "snapshotId",s.document
       FROM orders_snapshots s JOIN orders_projections p ON p.tenant_id=s.tenant_id AND p.entity_id=s.entity_id
        AND p.connection_id=s.connection_id AND p.snapshot_id=s.id
       WHERE s.tenant_id=$1 AND s.order_id=$2 AND s.kind IN ('return','refund')`,
      [tenantId, orderId],
    )
  ).rows;
  const numbers = new Map(
    (
      await tx.query<{ connectionId: string; displayNumber: string | null }>(
        `SELECT p.connection_id AS "connectionId",s.display_number AS "displayNumber"
         FROM orders_projections p JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
         WHERE p.tenant_id=$1 AND p.entity_id=$2`,
        [tenantId, orderId],
      )
    ).rows.map((row) => [row.connectionId, row.displayNumber]),
  );
  const returns = current.filter((row) => row.document.data.type === 'return');
  const refunds = current.filter((row) => row.document.data.type === 'refund');
  const settles = (refund: Current, ret: Current) =>
    refund.connectionId === ret.connectionId &&
    (refund.document.data as RefundData).returnId === ret.entityId;
  const rows = [
    ...returns.map((row) => {
      const data = row.document.data as ReturnData;
      const linked = refunds.filter((refund) => settles(refund, row));
      const refundData = linked.map(
        (refund) => refund.document.data as RefundData,
      );

      return listRow(
        row,
        returnProgress(data, refundData),
        data.name,
        data.status,
        data.requestedAt,
        [
          data.requestedAt,
          data.approvedAt,
          data.closedAt,
          data.receivedAt,
          ...refundData.flatMap((refund) => [
            refund.createdAt,
            ...refund.transactions.map((t) => t.processedAt),
          ]),
        ],
        data.lines.map((line) => line.reason),
      );
    }),
    ...refunds
      .filter((refund) => !returns.some((row) => settles(refund, row)))
      .map((row) => {
        const data = row.document.data as RefundData;

        return listRow(
          row,
          refundProgress(data),
          null,
          null,
          data.createdAt,
          [data.createdAt, ...data.transactions.map((t) => t.processedAt)],
          [],
        );
      }),
  ];
  await tx.query(
    'DELETE FROM orders_returns WHERE tenant_id=$1 AND order_id=$2',
    [tenantId, orderId],
  );
  if (!rows.length) return;
  await tx.query(
    `INSERT INTO orders_returns(tenant_id,entity_id,connection_id,snapshot_id,order_id,kind,name,order_number,status,
      stage,stage_group,refund_state,quantity,received,refunded_units,value_amount,value_currency,currency,
      refunded_amount,pending_amount,failed_attempts,reasons,requested_at,requested_key,activity_at,observed_at,
      source_updated_at,deleted)
     SELECT $1,r.entity_id,r.connection_id,r.snapshot_id,$2,r.kind,r.name,r.order_number,r.status,r.stage,r.stage_group,
      r.refund_state,r.quantity,r.received,r.refunded_units,r.value_amount,r.value_currency,r.currency,
      r.refunded_amount,r.pending_amount,r.failed_attempts,r.reasons,r.requested_at,
      COALESCE(r.requested_at,r.observed_at),COALESCE(r.activity_at,r.observed_at),r.observed_at,
      r.source_updated_at,r.deleted
     FROM jsonb_to_recordset($3::jsonb) AS r(entity_id uuid,connection_id uuid,snapshot_id uuid,kind text,name text,
      order_number text,status text,stage text,stage_group text,refund_state text,quantity numeric,received numeric,
      refunded_units numeric,value_amount numeric,value_currency text,currency text,refunded_amount numeric,
      pending_amount numeric,failed_attempts integer,reasons text[],requested_at timestamptz,activity_at timestamptz,
      observed_at timestamptz,source_updated_at timestamptz,deleted boolean)`,
    [tenantId, orderId, JSON.stringify(rows)],
  );

  function listRow(
    row: Current,
    progress: ReturnProgress,
    name: string | null,
    status: string | null,
    requestedAt: string | null,
    events: (string | null)[],
    reasons: (string | null)[],
  ) {
    return {
      entity_id: row.entityId,
      connection_id: row.connectionId,
      snapshot_id: row.snapshotId,
      kind: row.document.data.type,
      name,
      order_number: numbers.get(row.connectionId) ?? null,
      status,
      stage: progress.stage,
      stage_group: progress.group,
      refund_state: progress.refund,
      quantity: progress.quantity,
      received: progress.received,
      refunded_units: progress.refundedUnits,
      value_amount: progress.value?.amount ?? null,
      value_currency: progress.value?.currency ?? null,
      currency: progress.currency,
      refunded_amount: progress.refunded,
      pending_amount: progress.pending,
      failed_attempts: progress.failedAttempts,
      reasons: [
        ...new Set(reasons.filter((reason): reason is string => !!reason)),
      ],
      requested_at: requestedAt,
      activity_at: latest([...events, row.document.sourceUpdatedAt]),
      observed_at: row.document.observedAt,
      source_updated_at: row.document.sourceUpdatedAt,
      deleted: row.document.deleted,
    };
  }
}
