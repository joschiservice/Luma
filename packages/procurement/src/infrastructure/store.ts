import type { AuditLog } from '@luma/audit';
import type { TenantDatabase } from '@luma/platform';

import type { ProcurementStore } from '../application/procurement.js';
import type {
  Commitment,
  FollowUp,
  Submission,
} from '../domain/commitments.js';
import type { PurchaseOrder, Supplier } from '../domain/procurement.js';
import {
  effectiveSupplierTerms,
  type SupplierTermsVersion,
} from '../domain/supplier-terms.js';

/** Persists procurement records and audit in the same tenant transaction. */
export function createProcurementStore(
  db: TenantDatabase,
  audit: (db: TenantDatabase) => AuditLog,
): ProcurementStore {
  return {
    transaction: (tenantId, write, operation) =>
      db.transaction(tenantId, async (tx) => {
        // Readers share a lock so order revisions and audit history cannot straddle a write.
        await tx.query(
          write
            ? 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))'
            : 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',
          [`procurement:${tenantId}`],
        );
        const scoped: TenantDatabase = {
          transaction: async (_tenant, fn) => fn(tx),
        };
        const log = audit(scoped);

        return operation({
          suppliers: async () =>
            (
              await tx.query<{ document: Supplier }>(
                "SELECT document FROM procurement_suppliers WHERE tenant_id=$1 ORDER BY document->>'name',id",
                [tenantId],
              )
            ).rows.map((r) => r.document),
          orders: async () =>
            (
              await tx.query<{ document: PurchaseOrder }>(
                'SELECT document FROM procurement_purchase_orders WHERE tenant_id=$1 ORDER BY created_at DESC,id',
                [tenantId],
              )
            ).rows.map((r) => r.document),
          supplier: async (id) =>
            (
              await tx.query<{ document: Supplier }>(
                'SELECT document FROM procurement_suppliers WHERE tenant_id=$1 AND id=$2',
                [tenantId, id],
              )
            ).rows[0]?.document ?? null,
          order: async (id) =>
            (
              await tx.query<{ document: PurchaseOrder }>(
                'SELECT document FROM procurement_purchase_orders WHERE tenant_id=$1 AND id=$2',
                [tenantId, id],
              )
            ).rows[0]?.document ?? null,
          shortfallState: async (orderId) => {
            const order = (
              await tx.query<{ document: PurchaseOrder }>(
                'SELECT document FROM procurement_purchase_orders WHERE tenant_id=$1 AND id=$2',
                [tenantId, orderId],
              )
            ).rows[0]?.document;
            if (!order) return null;
            const commitments = (
              await tx.query<{ document: Commitment }>(
                'SELECT document FROM procurement_commitments WHERE tenant_id=$1 AND purchase_order_id=$2 ORDER BY recorded_at,id',
                [tenantId, orderId],
              )
            ).rows.map((row) => row.document);
            const followUps = (
              await tx.query<{ document: FollowUp }>(
                'SELECT document FROM procurement_follow_ups WHERE tenant_id=$1 AND purchase_order_id=$2 ORDER BY responded_at,id',
                [tenantId, orderId],
              )
            ).rows.map((row) => row.document);
            const submission =
              (
                await tx.query<{ document: Submission }>(
                  'SELECT document FROM procurement_submissions WHERE tenant_id=$1 AND purchase_order_id=$2 ORDER BY created_at DESC,id LIMIT 1',
                  [tenantId, orderId],
                )
              ).rows[0]?.document ?? null;

            return { order, commitments, followUps, submission };
          },
          submittedNativeOrder: async (orderId) =>
            (
              await tx.query(
                "SELECT 1 FROM procurement_submissions WHERE tenant_id=$1 AND purchase_order_id=$2 AND COALESCE(document->>'channel','purchasing_system')='purchasing_system' AND state IN ('submitting','uncertain','submitted') LIMIT 1",
                [tenantId, orderId],
              )
            ).rows.length > 0,
          pendingOrderChange: async (orderId) =>
            (
              await tx.query(
                "SELECT 1 FROM procurement_order_changes WHERE tenant_id=$1 AND purchase_order_id=$2 AND state IN ('preparing','approval_required','approved','submitting','uncertain') LIMIT 1",
                [tenantId, orderId],
              )
            ).rows.length > 0,
          termSnapshots: async (supplierId, sku) => {
            const rows = (
              await tx.query<{ document: SupplierTermsVersion }>(
                `WITH candidates AS (SELECT e.id AS sku_id FROM inventory_entities e WHERE e.tenant_id=$1 AND e.kind='sku' AND (e.id::text=$3 OR e.reconciliation_key=$3 OR EXISTS(SELECT 1 FROM inventory_product_skus p WHERE p.tenant_id=e.tenant_id AND p.sku_id=e.id AND p.code=$3)))
               SELECT t.document FROM procurement_supplier_terms t JOIN candidates c ON c.sku_id=t.sku_id
               WHERE t.tenant_id=$1 AND t.supplier_id=$2 AND (SELECT count(*) FROM candidates)=1 ORDER BY t.revision`,
                [tenantId, supplierId, sku],
              )
            ).rows;
            const values = effectiveSupplierTerms(
              rows.map((row) => row.document),
              new Date().toISOString().slice(0, 10),
            ).effective;

            return {
              ...(values.unitPrice?.currency
                ? {
                    unitPrice: {
                      amount: values.unitPrice.amount,
                      currency: values.unitPrice.currency,
                    },
                  }
                : {}),
              ...(values.supplierArticleNumber
                ? { supplierArticleNumber: values.supplierArticleNumber }
                : {}),
            };
          },
          updateSupplier: async (s) => {
            await tx.query(
              'UPDATE procurement_suppliers SET document=$3 WHERE tenant_id=$1 AND id=$2',
              [tenantId, s.id, s],
            );
          },
          insertSupplier: async (s) => {
            await tx.query(
              'INSERT INTO procurement_suppliers(tenant_id,id,document) VALUES($1,$2,$3)',
              [tenantId, s.id, s],
            );
          },
          insertOrder: async (o) => {
            await tx.query(
              'INSERT INTO procurement_purchase_orders(tenant_id,id,supplier_id,document,created_at) VALUES($1,$2,$3,$4,$5)',
              [tenantId, o.id, o.supplierId, o, o.createdAt],
            );
          },
          updateOrder: async (o) => {
            await tx.query(
              `UPDATE procurement_purchase_orders SET document=jsonb_set(jsonb_set(jsonb_set(document,'{status}',$3::jsonb),'{revision}',$4::jsonb),'{updatedAt}',$5::jsonb) WHERE tenant_id=$1 AND id=$2`,
              [
                tenantId,
                o.id,
                JSON.stringify(o.status),
                JSON.stringify(o.revision),
                JSON.stringify(o.updatedAt),
              ],
            );
          },
          command: async (id) =>
            (
              await tx.query<{
                digest: string;
                result: PurchaseOrder | Supplier;
              }>(
                'SELECT digest,result FROM procurement_commands WHERE tenant_id=$1 AND id=$2',
                [tenantId, id],
              )
            ).rows[0] ?? null,
          saveCommand: async (id, digest, result) => {
            await tx.query(
              'INSERT INTO procurement_commands(tenant_id,id,digest,result) VALUES($1,$2,$3,$4)',
              [tenantId, id, digest, result],
            );
          },
          audit: (entry) => log.append(entry),
          history: async (id) =>
            (await log.list(tenantId, id))
              .filter((e) =>
                [
                  'purchase_order.created',
                  'purchase_order.status_changed',
                  'purchase_order.revised',
                ].includes(e.eventType),
              )
              .map((e) => ({
                id: e.id,
                commandId: e.details.commandId,
                occurredAt: e.occurredAt,
                actorId: e.actor.id,
                from: (e.details.from || null) as
                  PurchaseOrder['status'] | null,
                to: e.details.to as PurchaseOrder['status'],
                revision: Number(e.details.revision),
                reason: e.details.reason!,
              }))
              .sort((a, b) => a.revision - b.revision),
        });
      }),
  };
}
