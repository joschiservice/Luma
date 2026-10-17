import type { TenantDatabase } from '@luma/platform';

import type { DetectionMonitorOptions } from '../../application/detection-monitor.js';

/**
 * Deliberate cross-owner read of an active stock protection hold for one position, between the
 * mapping's selling source and its authority. Mappings without an authority have no hold.
 */
export function createStockProtectionHoldReader(
  database: TenantDatabase,
): NonNullable<DetectionMonitorOptions['protection']> {
  return (context, positionId, mapping) =>
    database.transaction(context.tenantId, async (tx) => {
      const selling =
        mapping.sellingSource === 'left' ? mapping.left : mapping.right;
      const authority =
        mapping.authority === 'left'
          ? mapping.left
          : mapping.authority === 'right'
            ? mapping.right
            : null;
      if (!authority) return null;
      const row = (
        await tx.query<{ id: string; available: string; observedAt: string }>(
          `SELECT p->>'id' AS id,p->>'held' AS available,p->>'startedAt' AS "observedAt" FROM shopify_stock_protection_incidents i CROSS JOIN LATERAL jsonb_array_elements(i.document->'view'->'positions') p WHERE i.tenant_id=$1 AND i.connection_id=$2 AND i.source_connection_id=$3 AND p->>'positionId'=$4 AND p->>'status' IN ('held','tightened','releasing','unknown') AND p->>'startedAt' IS NOT NULL AND p->>'endedAt' IS NULL ORDER BY i.created_at DESC LIMIT 1`,
          [
            context.tenantId,
            selling.source.connectionId,
            authority.source.connectionId,
            positionId,
          ],
        )
      ).rows[0];

      return row ?? null;
    });
}
