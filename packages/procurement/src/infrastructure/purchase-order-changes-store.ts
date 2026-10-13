import { randomUUID } from 'node:crypto';

import type { AuditLog } from '@luma/audit';
import type { TenantDatabase } from '@luma/platform';

import type { PurchaseOrderChangeStore } from '../application/purchase-order-changes.js';
import type { PurchaseOrder } from '../domain/procurement.js';
import type {
  PurchaseOrderChange,
  PurchaseOrderRevision,
} from '../domain/purchase-order-changes.js';

/** Commits immutable order revisions and audit under the procurement tenant lock. */
export function createPurchaseOrderChangeStore(
  db: TenantDatabase,
  audit: (db: TenantDatabase) => AuditLog,
): PurchaseOrderChangeStore {
  return {
    transaction: (tenantId, write, operation) =>
      db.transaction(tenantId, async (tx) => {
        await tx.query(
          write
            ? 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))'
            : 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',
          [`procurement:${tenantId}`],
        );
        const log = audit({ transaction: async (_tenant, fn) => fn(tx) });
        const auditChange = async (
          change: PurchaseOrderChange,
          verified: boolean,
          occurredAt: string,
        ) =>
          log.append({
            id: randomUUID(),
            tenantId,
            eventKey: `procurement-order-change:${change.id}:${verified ? 'verified' : 'requested'}`,
            eventType: verified
              ? 'purchase_order.revised'
              : 'purchase_order.change_requested',
            schemaVersion: 1,
            occurredAt,
            actor: { kind: 'user', id: change.requestedBy },
            correlationId: change.id,
            proposalId: change.purchaseOrderId,
            actionHash: change.requestDigest,
            evidenceRefs: [change.id, ...change.observationRefs],
            details: {
              purchaseOrderId: change.purchaseOrderId,
              commandId: change.id,
              revision: String(
                verified ? change.proposed.revision : change.baseline.revision,
              ),
              from: change.baseline.status,
              to: change.proposed.status,
              reason: change.request.reason,
              operation: change.request.operation.kind,
              approverId: change.decidedBy ?? '',
            },
          });

        return operation({
          order: async (id) =>
            (
              await tx.query<{ document: PurchaseOrder }>(
                'SELECT document FROM procurement_purchase_orders WHERE tenant_id=$1 AND id=$2',
                [tenantId, id],
              )
            ).rows[0]?.document ?? null,
          changes: async (orderId, states) =>
            (
              await tx.query<{ document: PurchaseOrderChange }>(
                "SELECT document FROM procurement_order_changes WHERE tenant_id=$1 AND ($2::uuid IS NULL OR purchase_order_id=$2) AND ($3::text[] IS NULL OR state=ANY($3::text[])) ORDER BY document->>'requestedAt' DESC,id",
                [tenantId, orderId ?? null, states ?? null],
              )
            ).rows.map((r) => r.document),
          change: async (id) =>
            (
              await tx.query<{ document: PurchaseOrderChange }>(
                'SELECT document FROM procurement_order_changes WHERE tenant_id=$1 AND id=$2',
                [tenantId, id],
              )
            ).rows[0]?.document ?? null,
          insert: async (change) => {
            await tx.query(
              'INSERT INTO procurement_order_changes(tenant_id,id,purchase_order_id,state,document) VALUES($1,$2,$3,$4,$5)',
              [
                tenantId,
                change.id,
                change.purchaseOrderId,
                change.state,
                change,
              ],
            );
            await auditChange(change, false, change.requestedAt);
          },
          save: async (change) => {
            await tx.query(
              'UPDATE procurement_order_changes SET state=$3,document=$4 WHERE tenant_id=$1 AND id=$2',
              [tenantId, change.id, change.state, change],
            );
          },
          revisions: async (orderId) =>
            (
              await tx.query<{ document: PurchaseOrderRevision }>(
                'SELECT document FROM procurement_order_revisions WHERE tenant_id=$1 AND purchase_order_id=$2 ORDER BY revision',
                [tenantId, orderId],
              )
            ).rows.map((r) => r.document),
          supplierLink: async (supplierId) =>
            (
              await tx.query<{
                link: {
                  connectionId: string;
                  externalId: string;
                  scopeKey: string;
                } | null;
              }>(
                `SELECT document->'link' AS link FROM procurement_suppliers WHERE tenant_id=$1 AND id=$2`,
                [tenantId, supplierId],
              )
            ).rows[0]?.link ?? null,
          skuIdentity: async (connectionId, sku) => {
            const rows = (
              await tx.query<{ external_id: string; scope_key: string }>(
                `WITH candidates AS (SELECT e.id FROM inventory_entities e WHERE e.tenant_id=$1 AND e.kind='sku' AND (e.id::text=$3 OR e.reconciliation_key=$3 OR EXISTS(SELECT 1 FROM inventory_product_skus p WHERE p.tenant_id=e.tenant_id AND p.sku_id=e.id AND p.code=$3))) SELECT DISTINCT m.external_id,m.scope_key FROM candidates c JOIN connector_source_mappings m ON m.tenant_id=$1 AND m.canonical_id=c.id AND m.resource='sku' AND m.connection_id=$2 WHERE (SELECT count(*) FROM candidates)=1`,
                [tenantId, connectionId, sku],
              )
            ).rows;

            return rows.length === 1
              ? {
                  externalId: rows[0]!.external_id,
                  scopeKey: rows[0]!.scope_key,
                }
              : null;
          },
          apply: async (change, observedAt, observationRefs) => {
            const old: PurchaseOrderRevision = {
              order: change.baseline,
              changeId: null,
              reason: 'Previous recorded order revision',
              recordedBy: change.requestedBy,
              recordedAt: change.requestedAt,
              observationRefs: [],
            };
            const updated: PurchaseOrderRevision = {
              order: { ...change.proposed, updatedAt: observedAt },
              changeId: change.id,
              reason: change.request.reason,
              recordedBy: change.requestedBy,
              recordedAt: observedAt,
              observationRefs,
            };
            await tx.query(
              'INSERT INTO procurement_order_revisions(tenant_id,purchase_order_id,revision,document) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
              [tenantId, change.purchaseOrderId, change.baseline.revision, old],
            );
            await tx.query(
              'INSERT INTO procurement_order_revisions(tenant_id,purchase_order_id,revision,document) VALUES($1,$2,$3,$4)',
              [
                tenantId,
                change.purchaseOrderId,
                change.proposed.revision,
                updated,
              ],
            );
            await tx.query(
              "UPDATE procurement_purchase_orders SET document=$3 WHERE tenant_id=$1 AND id=$2 AND (document->>'revision')::integer=$4",
              [
                tenantId,
                change.purchaseOrderId,
                updated.order,
                change.baseline.revision,
              ],
            );
            await auditChange({ ...change, observationRefs }, true, observedAt);
          },
        });
      }),
  };
}
