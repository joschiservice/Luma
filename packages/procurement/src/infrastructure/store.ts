import type { AuditLog } from '@luma/audit';
import type { TenantDatabase } from '@luma/platform';

import type { ProcurementStore } from '../application/procurement.js';
import type { PurchaseOrder, Supplier } from '../domain/procurement.js';

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
              .filter((e) => e.eventType.startsWith('purchase_order.'))
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
