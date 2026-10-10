import type { SqlTransaction } from '@luma/platform';

import type {
  OrderDetail,
  OrderDifference,
  OrderSourceFacts,
} from '../../application/orders.js';
import type { OrderReadQueries } from './list-query.js';
import { connectionLabel, iso, money, object, text } from './values.js';

type SourceRow = {
  connectionId: string;
  document: Record<string, unknown>;
  connection: Record<string, unknown> | null;
  externalId: string | null;
  mappingMethod: string | null;
  fulfillment: OrderSourceFacts['fulfillment'];
  open: boolean | null;
  overdue: boolean | null;
  selected: boolean;
  progress: { fulfilled: string; remaining: string | null }[];
  values: Record<string, string | null> | null;
  differences: Record<string, boolean> | null;
};

// $1 tenant, $2 as-of time, $3 order ID.
function sourcesSql({ state }: OrderReadQueries) {
  return `WITH ${state.currentOrderSources('order_sources', 'p.entity_id=$3')},
 ${state.orderProgress('order_sources')}, ${state.sourceComparison('order_sources', 'order_sources')}
SELECT o.connection_id AS "connectionId",s.document,ci.document AS connection,
 m.external_id AS "externalId",m.method AS "mappingMethod",o.fulfillment,o.open,o.overdue,
 o.connection_id=(SELECT connection_id FROM order_sources ORDER BY ${state.sourceSelectionOrder} LIMIT 1) AS selected,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('fulfilled',trim_scale(lp.fulfilled)::text,
  'remaining',trim_scale(lp.remaining)::text) ORDER BY lp.position) FROM order_line_progress lp
  WHERE lp.entity_id=o.entity_id AND lp.connection_id=o.connection_id),'[]'::jsonb) AS progress,
 to_jsonb(v)-'entity_id'-'connection_id' AS "values",to_jsonb(d)-'entity_id' AS differences
FROM order_state o
JOIN orders_snapshots s ON s.tenant_id=$1 AND s.id=o.snapshot_id
LEFT JOIN source_values v ON v.entity_id=o.entity_id AND v.connection_id=o.connection_id
LEFT JOIN source_differences d ON d.entity_id=o.entity_id
LEFT JOIN connector_installations ci ON ci.tenant_id=$1 AND ci.id=o.connection_id
LEFT JOIN LATERAL (SELECT mapping.external_id,COALESCE(revision.method,mapping.method) AS method
 FROM connector_source_mappings mapping LEFT JOIN LATERAL (SELECT method FROM connector_mapping_revisions
  WHERE tenant_id=mapping.tenant_id AND mapping_id=mapping.id ORDER BY created_at DESC,id DESC LIMIT 1) revision ON true
 WHERE mapping.tenant_id=$1 AND mapping.connection_id=o.connection_id AND resource='order' AND canonical_id=o.entity_id
 ORDER BY mapping.created_at,mapping.id LIMIT 1) m ON true
ORDER BY o.connection_id`;
}

const comparedFields: [OrderDifference['field'], string][] = [
  ['status', 'status'],
  ['paymentStatus', 'payment_status'],
  ['total', 'total'],
  ['lines', 'lines'],
];

/**
 * Reads every current source of one order with its state, line progress and differences, and
 * whether the selected source is overdue. Returns null when the order has no current source.
 */
export async function readSourceFacts(
  tx: SqlTransaction,
  queries: OrderReadQueries,
  tenantId: string,
  orderId: string,
  asOf: string,
) {
  const rows = (
    await tx.query<SourceRow>(sourcesSql(queries), [tenantId, asOf, orderId])
  ).rows;
  if (!rows.length) return null;
  const sources: OrderSourceFacts[] = rows.map((row) => {
    const data = object(row.document.data);
    const connection = object(row.connection);
    const lines = (Array.isArray(data.lines) ? data.lines : []).map(
      (value, index) => {
        const line = object(value);
        const progress = row.progress[index];

        return {
          id: String(line.id),
          skuId: text(line.skuId),
          skuCode: text(line.skuCode),
          title: text(line.title),
          quantity: String(line.quantity),
          currentQuantity: text(line.currentQuantity),
          cancelledQuantity: text(line.cancelledQuantity),
          unit: String(line.unit),
          fulfilledQuantity: progress?.fulfilled ?? '0',
          remainingQuantity: progress?.remaining ?? null,
        };
      },
    );

    return {
      connectionId: row.connectionId,
      label: connectionLabel(connection),
      system: text(object(connection.target).kind),
      connectionStatus: text(connection.status) ?? 'unknown',
      appId: text(connection.appId),
      externalId: row.externalId,
      mappingMethod: row.mappingMethod,
      selected: row.selected,
      deleted: row.document.deleted === true,
      observedAt: iso(row.document.observedAt)!,
      sourceUpdatedAt: iso(row.document.sourceUpdatedAt),
      displayNumber: text(data.displayNumber),
      status: text(data.status) ?? 'unknown',
      paymentStatus: text(data.paymentStatus) ?? 'unknown',
      placedAt: iso(data.placedAt),
      total: money(data.total),
      dueAt: iso(data.dueAt),
      fulfillment: row.fulfillment,
      open: row.open,
      lines,
    };
  });
  const flags = rows[0]!.differences ?? {};
  const compared = rows.filter((row) => row.values);
  const differences: OrderDetail['differences'] = comparedFields
    .filter(([, column]) => flags[column] === true)
    .map(([field, column]) => ({
      field,
      values: compared.map((row) => ({
        connectionId: row.connectionId,
        value: row.values![column] ?? null,
      })),
    }));

  return {
    sources,
    differences,
    overdue: rows.find((row) => row.selected)?.overdue ?? null,
  };
}
