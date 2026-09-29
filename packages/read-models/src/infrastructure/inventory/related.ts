import type { SqlTransaction } from '@luma/platform';

import type {
  InventoryDetail,
  StockPosition,
} from '../../application/inventory.js';

/** Reads bounded history and SKU relationships; source identities require the same connection scope. */
export async function readStockContext(
  tx: SqlTransaction,
  tenantId: string,
  position: StockPosition,
): Promise<Omit<InventoryDetail, 'position' | 'asOf'>> {
  const history = await tx.query<{
    id: string;
    connectionId: string;
    document: {
      data: Record<string, string | null>;
      observedAt: string;
      sourceUpdatedAt: string | null;
      deleted: boolean;
    };
    current: boolean;
  }>(
    `SELECT s.id,s.connection_id AS "connectionId",s.document,
     EXISTS (SELECT 1 FROM inventory_projections p WHERE p.tenant_id=s.tenant_id AND p.snapshot_id=s.id) AS current
     FROM inventory_snapshots s WHERE s.tenant_id=$1 AND s.entity_id=$2
     ORDER BY s.observed_at DESC,s.created_at DESC,s.id DESC LIMIT 101`,
    [tenantId, position.id],
  );
  const orders = await tx.query<InventoryDetail['orders'][number]>(
    `SELECT s.entity_id AS id,COALESCE(s.document->'data'->>'displayNumber',s.entity_id::text) AS label,
     s.document->'data'->>'status' AS status,s.connection_id AS "connectionId",
     sum((line->>'quantity')::numeric)::text AS quantity,line->>'unit' AS unit
     FROM orders_projections p JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
     CROSS JOIN LATERAL jsonb_array_elements(s.document->'data'->'lines') line
     WHERE p.tenant_id=$1 AND s.kind='order' AND NOT (s.document->>'deleted')::boolean
     AND line->>'skuId'=$2
     GROUP BY s.entity_id,s.connection_id,s.document,line->>'unit'
     ORDER BY s.document->'data'->>'status'='open' DESC,s.entity_id,s.connection_id LIMIT 51`,
    [tenantId, position.skuId],
  );
  // Replenishment uses the canonical SKU reconciliation key on purchase order lines.
  const purchaseOrders = await tx.query<
    InventoryDetail['purchaseOrders'][number]
  >(
    `SELECT p.id,p.document->>'reference' AS label,p.document->>'status' AS status,
     sum((line->>'quantity')::numeric)::float8 AS quantity,line->>'unit' AS unit
     FROM procurement_purchase_orders p CROSS JOIN LATERAL jsonb_array_elements(p.document->'lines') line
     WHERE p.tenant_id=$1 AND line->>'sku' IN ($2,$3)
     GROUP BY p.id,p.document,line->>'unit' ORDER BY p.document->>'status'='open' DESC,p.id LIMIT 51`,
    [tenantId, position.skuId, position.skuKey],
  );
  const issues = await tx.query<InventoryDetail['issues'][number]>(
    `SELECT DISTINCT e.id,COALESCE(e.document->>'summary',e.document->>'exceptionClass','Stock issue') AS label,e.state
     FROM exceptions e WHERE e.tenant_id=$1 AND (
      (e.subject_kind='position' AND e.subject_id=$2) OR
      (e.subject_kind='sku' AND (e.subject_id=$3 OR (e.subject_id=$4 AND EXISTS (
       SELECT 1 FROM inventory_projections p WHERE p.tenant_id=e.tenant_id AND p.entity_id=$2::uuid
       AND e.document->'subject'->'scope' ? p.connection_id::text)) OR EXISTS (
       SELECT 1 FROM connector_source_mappings m WHERE m.tenant_id=e.tenant_id AND m.resource='sku'
       AND m.canonical_id=$3::uuid AND m.external_id=e.subject_id
       AND e.document->'subject'->'scope' ? m.connection_id::text))))
     ORDER BY e.state,e.id LIMIT 51`,
    [tenantId, position.id, position.skuId, position.skuKey],
  );

  return {
    history: {
      entries: history.rows.slice(0, 100).map((row) => {
        const source = position.sources.find(
          (s) => s.connectionId === row.connectionId,
        )!;

        return {
          ...source,
          id: row.id,
          current: row.current,
          observedAt: row.document.observedAt,
          sourceUpdatedAt: row.document.sourceUpdatedAt,
          deleted: row.document.deleted,
          onHand: row.document.data.onHand ?? null,
          reserved: row.document.data.reserved ?? null,
          available: row.document.data.available ?? null,
          availabilityBasis: row.document.data
            .availabilityBasis as typeof source.availabilityBasis,
        };
      }),
      truncated: history.rows.length > 100,
    },
    orders: orders.rows.slice(0, 50),
    purchaseOrders: purchaseOrders.rows.slice(0, 50),
    issues: issues.rows.slice(0, 50),
    relatedTruncated: [orders, purchaseOrders, issues].some(
      (result) => result.rows.length > 50,
    ),
  };
}
