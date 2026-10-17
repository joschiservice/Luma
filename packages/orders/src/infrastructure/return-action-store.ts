import type { AuditLog } from '@luma/audit';
import type { TenantDatabase } from '@luma/platform';

import type {
  ReturnActionStore,
  ReturnStockTarget,
} from '../application/return-actions.js';
import type { ReturnAction } from '../domain/return-actions.js';
import type { ReturnCase } from '../domain/return-cases.js';

/** Persists tenant-scoped settlement requests and reads explicitly mapped Wawi item identities. */
export function createReturnActionStore(
  db: TenantDatabase,
  audit: (db: TenantDatabase) => AuditLog,
): ReturnActionStore {
  return {
    transaction: (tenantId, fn, options) =>
      db.transaction(
        tenantId,
        async (tx) => {
          const log = audit({
            transaction: async (_tenant, operation) => operation(tx),
          });

          async function document(id: string) {
            return (
              (
                await tx.query<{ document: ReturnAction }>(
                  'SELECT document FROM orders_return_actions WHERE tenant_id=$1 AND id=$2',
                  [tenantId, id],
                )
              ).rows[0]?.document ?? null
            );
          }

          return fn({
            read: async (caseId) =>
              (
                await tx.query<{ document: ReturnCase }>(
                  'SELECT document FROM orders_return_cases WHERE tenant_id=$1 AND id=$2',
                  [tenantId, caseId],
                )
              ).rows[0]?.document ?? null,
            lock: async (caseId) => {
              const found = (
                await tx.query<{ document: ReturnCase }>(
                  'SELECT document FROM orders_return_cases WHERE tenant_id=$1 AND id=$2',
                  [tenantId, caseId],
                )
              ).rows[0]?.document;
              if (!found) return null;
              await tx.query(
                'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
                [`orders-return-cases:${tenantId}:${found.orderId}`],
              );

              return (
                (
                  await tx.query<{ document: ReturnCase }>(
                    'SELECT document FROM orders_return_cases WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
                    [tenantId, caseId],
                  )
                ).rows[0]?.document ?? null
              );
            },
            get: document,
            list: async (caseId) =>
              (
                await tx.query<{ document: ReturnAction }>(
                  'SELECT document FROM orders_return_actions WHERE tenant_id=$1 AND case_id=$2 ORDER BY requested_at,id',
                  [tenantId, caseId],
                )
              ).rows.map((r) => r.document),
            insert: async (value) => {
              await tx.query(
                'INSERT INTO orders_return_actions(tenant_id,id,case_id,connection_id,kind,order_line_id,state,sent,document,requested_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
                [
                  tenantId,
                  value.id,
                  value.caseId,
                  value.connectionId,
                  value.kind,
                  value.orderLineId,
                  value.state,
                  value.sent,
                  value,
                  value.requestedAt,
                ],
              );
            },
            save: async (value) => {
              await tx.query(
                'UPDATE orders_return_actions SET state=$3,sent=$4,document=$5 WHERE tenant_id=$1 AND id=$2',
                [tenantId, value.id, value.state, value.sent, value],
              );
            },
            audit: (entry) => log.append(entry),
            targets: async (value) => {
              const rows = await tx.query<
                Omit<ReturnStockTarget, 'warehouse'> & Record<string, unknown>
              >(
                `
          SELECT sku.id::text || ':' || (line->>'id') AS id,line->>'id' AS "orderLineId",
            sku.connection_id AS "connectionId",COALESCE(c.document->>'label','Wawi') AS label,
            jsonb_build_object('externalId',sku.external_id,'scopeKey',sku.scope_key) AS item,
            ARRAY[sku.id::text] AS "mappingIds"
          FROM orders_projections op JOIN orders_snapshots os ON os.tenant_id=op.tenant_id AND os.id=op.snapshot_id
          CROSS JOIN LATERAL jsonb_array_elements(os.document->'data'->'lines') line
          JOIN connector_source_mappings sku ON sku.tenant_id=op.tenant_id AND sku.resource='sku' AND sku.canonical_id=(line->>'skuId')::uuid
          JOIN connector_installations c ON c.tenant_id=sku.tenant_id AND c.id=sku.connection_id
          WHERE op.tenant_id=$1 AND op.entity_id=COALESCE((SELECT target_entity_id FROM orders_entity_redirects WHERE tenant_id=$1 AND entity_id=$2),$2)
            AND op.connection_id=$3 AND line->>'id'=ANY($4::text[]) AND NOT (os.document->>'deleted')::boolean
            AND c.document->>'provider'='jtl' AND c.document->>'status'='active'
            AND c.document->'granted' ? 'returns.restock' AND c.document->'permissions' ? 'returns.restock'
            AND EXISTS(SELECT 1 FROM workspace_apps a WHERE a.tenant_id=c.tenant_id AND a.app_id=c.document->>'appId' AND a.status='installed' AND a.version=(c.document->>'appInstallationVersion')::int)
            AND (SELECT count(*) FROM connector_source_mappings m WHERE m.tenant_id=sku.tenant_id AND m.connection_id=sku.connection_id AND m.resource='sku' AND m.canonical_id=sku.canonical_id)=1
          ORDER BY line->>'id',sku.connection_id LIMIT 101`,
                [
                  tenantId,
                  value.orderId,
                  value.connectionId,
                  value.lines.map((l) => l.orderLineId),
                ],
              );

              // A cut-short choice list cannot establish the intended destination.
              return rows.rows.length > 100 ? [] : rows.rows;
            },
          });
        },
        options,
      ),
  };
}
