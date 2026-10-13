import type { TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import type { InventoryWriteReceipt } from './inventory-write-attribution.js';

/** Reads the latest accepted correction per exact source target; older receipts without an adjustment identity cannot prove an echo. */
export function readInventoryWriteReceipts(
  database: TenantDatabase,
  context: TenantContext,
  connectionId: string,
  targets: { inventoryItemId: string; locationId: string }[],
): Promise<InventoryWriteReceipt[]> {
  return database.transaction(context.tenantId, async (tx) => {
    const result = await tx.query<{ receipt: InventoryWriteReceipt }>(
      `
      SELECT e.document || jsonb_build_object('evidenceId', e.id, 'observedAt', e.observed_at) AS receipt
      FROM (SELECT DISTINCT "inventoryItemId", "locationId"
        FROM jsonb_to_recordset($3::jsonb) AS t("inventoryItemId" text, "locationId" text)) targets
      JOIN LATERAL (SELECT id, document, observed_at FROM shopify_inventory_evidence
        WHERE tenant_id=$1 AND connection_id=$2 AND kind='acceptance'
        AND inventory_item_id=targets."inventoryItemId" AND location_id=targets."locationId"
        AND observed_at >= now()-interval '7 days'
        ORDER BY observed_at DESC,id DESC LIMIT 1) e ON true
      ORDER BY e.observed_at DESC,e.id DESC LIMIT 20`,
      [context.tenantId, connectionId, JSON.stringify(targets)],
    );

    return result.rows.map((row) => row.receipt);
  });
}
