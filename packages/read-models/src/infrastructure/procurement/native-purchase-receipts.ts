import type { TenantContext } from '@luma/identity';
import { requirePermission } from '@luma/identity';
import type { PurchaseReceiptEvidence } from '@luma/inventory';
import type { TenantDatabase } from '@luma/platform';
import { type Commitment, skuCandidateIdsSql } from '@luma/procurement';

/** Deliberate cross-owner read of manual procurement evidence and the receiving location's native scope. */
export function readNativePurchaseReceipt(
  db: TenantDatabase,
  context: TenantContext,
  purchaseOrderId: string,
  lineId: string,
): Promise<Omit<
  PurchaseReceiptEvidence,
  'bookedGood' | 'bookedDamaged' | 'trackedIncoming'
> | null> {
  requirePermission(context, 'procurement.manage');

  return db.transaction(context.tenantId, async (tx) => {
    const order = (
      await tx.query<{
        sku: string;
        location_id: string | null;
        unit: string;
        mode: string | null;
        scope_version: string | null;
        sku_id: string | null;
      }>(
        `SELECT line->>'sku' AS sku,line->>'locationId' AS location_id,line->>'unit' AS unit,scope.mode,scope.version::text AS scope_version,
       (SELECT e.id::text FROM inventory_entities e WHERE e.tenant_id=o.tenant_id AND e.kind='sku' AND e.id IN (${skuCandidateIdsSql('o.tenant_id', "line->>'sku'")}) LIMIT 1) AS sku_id
       FROM procurement_purchase_orders o JOIN procurement_suppliers supplier ON supplier.tenant_id=o.tenant_id AND supplier.id=o.supplier_id
       CROSS JOIN LATERAL jsonb_array_elements(o.document->'lines') line
       LEFT JOIN inventory_stock_ownership_scopes scope ON scope.tenant_id=o.tenant_id AND scope.location_id=(line->>'locationId')::uuid
       WHERE o.tenant_id=$1 AND o.id=$2 AND line->>'id'=$3 AND o.document->>'authority'='luma' AND o.document->>'status'='open'
       AND (supplier.document->'link' IS NULL OR supplier.document->'link'='null'::jsonb)
       AND NOT EXISTS(SELECT 1 FROM procurement_submissions s WHERE s.tenant_id=o.tenant_id AND s.purchase_order_id=o.id AND COALESCE(s.document->>'channel','purchasing_system')<>'email')`,
        [context.tenantId, purchaseOrderId, lineId],
      )
    ).rows[0];
    if (
      !order?.sku_id ||
      !order.location_id ||
      order.mode !== 'own' ||
      !order.scope_version
    )
      return null;
    const candidates = (
      await tx.query<{ id: string }>(
        `SELECT e.id FROM inventory_entities e WHERE e.tenant_id=$1 AND e.kind='sku' AND e.id IN (${skuCandidateIdsSql('$1', '$2::text')})`,
        [context.tenantId, order.sku],
      )
    ).rows;
    if (candidates.length !== 1) return null;
    const commitments = (
      await tx.query<{ document: Commitment }>(
        `SELECT c.document FROM procurement_commitments c WHERE c.tenant_id=$1 AND c.purchase_order_id=$2 AND c.document->>'lineId'=$3 AND c.document->>'kind' IN ('received','damaged') AND c.document->>'status'='confirmed' AND NOT EXISTS(SELECT 1 FROM procurement_commitments later WHERE later.tenant_id=c.tenant_id AND later.purchase_order_id=c.purchase_order_id AND later.document->>'supersedes'=c.id::text AND later.document->>'status'='confirmed') ORDER BY c.recorded_at,c.id`,
        [context.tenantId, purchaseOrderId, lineId],
      )
    ).rows.map((r) => r.document);
    const receipt = commitments.filter((c) => c.kind === 'received').at(-1);
    const damaged = commitments.filter((c) => c.kind === 'damaged').at(-1);
    if (
      !receipt ||
      receipt.source.kind !== 'manual_receipt' ||
      receipt.quantity === null
    )
      return null;
    const damagedQuantity = damaged?.quantity ?? 0;
    if (
      damagedQuantity > receipt.quantity ||
      receipt.quantity - damagedQuantity < 0
    )
      return null;

    return {
      purchaseOrderId,
      lineId,
      commitmentId: receipt.id,
      damagedCommitmentId: damaged?.id ?? null,
      skuId: order.sku_id,
      locationId: order.location_id,
      unit: order.unit,
      scopeVersion: order.scope_version,
      receivedAt: receipt.source.receivedAt,
      cumulativeGood: String(receipt.quantity - damagedQuantity),
      cumulativeDamaged: String(damagedQuantity),
    };
  });
}
