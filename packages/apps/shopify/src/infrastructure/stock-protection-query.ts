import type { TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

/** Explicit cross-owner reads for stalled pairs and candidate identities; eligibility is reread by the app. */
export function createProtectionQuery(database: TenantDatabase) {
  return {
    recovered: (context: TenantContext, id: string) =>
      database.transaction(
        context.tenantId,
        async (tx) =>
          !!(
            await tx.query(
              `SELECT 1 FROM exceptions WHERE tenant_id=$1 AND id=$2 AND state='resolved' AND document->'resolution'->>'kind'='verification' AND document->'resolution'->>'outcome'='passed' AND (document->'resolution'->>'authoritative')::boolean`,
              [context.tenantId, id],
            )
          ).rowCount,
      ),
    writeRevision: (context: TenantContext) =>
      database.transaction(
        context.tenantId,
        async (tx) =>
          (
            await tx.query<{ revision: number }>(
              'SELECT revision FROM workspace_settings WHERE tenant_id=$1',
              [context.tenantId],
            )
          ).rows[0]?.revision ?? 0,
      ),
    stalls: (context: TenantContext) =>
      database.transaction(
        context.tenantId,
        async (tx) =>
          (
            await tx.query<{
              id: string;
              connectionId: string;
              sourceConnectionId: string;
              label: string;
              resolved: boolean;
            }>(
              `
      SELECT e.id,e.document->'subject'->>'subjectId' AS "connectionId",e.document->'subject'->'scope'->>0 AS "sourceConnectionId",
       c.document->>'label' AS label,e.document->>'state'='resolved' AS resolved FROM exceptions e
       JOIN connector_installations c ON c.tenant_id=e.tenant_id AND c.id=(e.document->'subject'->>'subjectId')::uuid
       WHERE e.tenant_id=$1 AND e.document->>'exceptionClass'='stock_sync_stall' AND c.document->>'provider'='shopify'
       ORDER BY e.document->>'firstDetectedAt' DESC LIMIT 100`,
              [context.tenantId],
            )
          ).rows,
      ),
    candidates: (
      context: TenantContext,
      connectionId: string,
      positionId?: string,
    ) =>
      database.transaction(
        context.tenantId,
        async (tx) =>
          (
            await tx.query<{
              positionId: string;
              skuId: string;
              available: number | null;
              native: boolean;
              unsettled: boolean;
            }>(
              `
      SELECT p.entity_id AS "positionId",s.sku_id AS "skuId",p.available::double precision AS available,
       EXISTS(SELECT 1 FROM inventory_stock_ownership_scopes o WHERE o.tenant_id=p.tenant_id AND o.location_id=s.location_id AND o.mode='own') AS native,
       EXISTS(SELECT 1 FROM shopify_inventory_corrections r LEFT JOIN executed_actions e ON e.tenant_id=r.tenant_id AND e.proposal_id=r.id
        WHERE r.tenant_id=p.tenant_id AND r.position_id=p.entity_id AND r.connection_id=p.connection_id
         AND ((e.id IS NULL AND (r.document->'action'->>'expiresAt')::timestamptz>now()) OR (e.state IN ('prepared','unknown') OR (e.state='failed' AND e.document->'attempt'->>'dispatch'<>'not_dispatched')))) AS unsettled
      FROM inventory_projections p JOIN inventory_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
      WHERE p.tenant_id=$1 AND p.connection_id=$2 AND ($3::uuid IS NULL OR p.entity_id=$3) AND s.kind='position' AND NOT (s.document->>'deleted')::boolean
      ORDER BY p.available ASC NULLS LAST,p.entity_id LIMIT 10000`,
              [context.tenantId, connectionId, positionId ?? null],
            )
          ).rows,
      ),
    sales: (context: TenantContext, skuId: string, connectionId: string) =>
      database.transaction(context.tenantId, async (tx) =>
        Number(
          (
            await tx.query<{ quantity: string }>(
              `SELECT COALESCE(sum((line->>'quantity')::numeric),0)::text AS quantity FROM orders_projections p JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id CROSS JOIN LATERAL jsonb_array_elements(s.document->'data'->'lines') line WHERE p.tenant_id=$1 AND p.connection_id=$2 AND s.kind='order' AND (s.document->'data'->>'placedAt')::timestamptz>now()-interval '24 hours' AND line->>'skuId'=$3 AND s.document->'data'->>'status'<>'cancelled'`,
              [context.tenantId, connectionId, skuId],
            )
          ).rows[0]!.quantity,
        ),
      ),
    healthy: (context: TenantContext, connectionIds: string[]) =>
      database.transaction(context.tenantId, async (tx) => {
        const rows = await tx.query<{
          connection_id: string;
          complete: boolean;
        }>(
          `SELECT connection_id,bool_and(last_complete_at>now()-interval '5 minutes' AND error_at IS NULL) AS complete FROM commerce_sync_streams WHERE tenant_id=$1 AND connection_id=ANY($2::uuid[]) AND record_type='inventory' GROUP BY connection_id`,
          [context.tenantId, connectionIds],
        );

        return connectionIds.every((id) =>
          rows.rows.some((row) => row.connection_id === id && row.complete),
        );
      }),
  };
}
