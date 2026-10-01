import type { AuditLog } from '@luma/audit';
import type { TenantDatabase } from '@luma/platform';

import type { CommitmentStore } from '../application/commitments.js';
import type { ProcurementEvent } from '../application/procurement.js';
import type {
  Commitment,
  Communication,
  Extraction,
  FollowUp,
  PurchasingObservation,
  Submission,
} from '../domain/commitments.js';
import type { PurchaseOrder, Supplier } from '../domain/procurement.js';

const live = ['approved', 'submitting', 'uncertain', 'submitted'];

/** Persists supplier commitments with procurement records and audit in one tenant transaction. */
export function createCommitmentStore(
  db: TenantDatabase,
  audit: (db: TenantDatabase) => AuditLog,
): CommitmentStore {
  return {
    transaction: (tenantId, write, operation) =>
      db.transaction(tenantId, async (tx) => {
        // The same lock as procurement records keeps orders, submissions and audit consistent.
        await tx.query(
          write
            ? 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))'
            : 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',
          [`procurement:${tenantId}`],
        );
        const log = audit({ transaction: async (_tenant, fn) => fn(tx) });
        const documents = async <T>(sql: string, params: unknown[]) =>
          (await tx.query<{ document: T }>(sql, params)).rows.map(
            (r) => r.document,
          );

        return operation({
          order: async (id) =>
            (
              await documents<PurchaseOrder>(
                'SELECT document FROM procurement_purchase_orders WHERE tenant_id=$1 AND id=$2',
                [tenantId, id],
              )
            )[0] ?? null,
          orders: () =>
            documents<PurchaseOrder>(
              'SELECT document FROM procurement_purchase_orders WHERE tenant_id=$1 ORDER BY created_at DESC,id',
              [tenantId],
            ),
          supplier: async (id) =>
            (
              await documents<Supplier>(
                'SELECT document FROM procurement_suppliers WHERE tenant_id=$1 AND id=$2',
                [tenantId, id],
              )
            )[0] ?? null,
          updateSupplier: async (supplier) => {
            await tx.query(
              'UPDATE procurement_suppliers SET document=$3 WHERE tenant_id=$1 AND id=$2',
              [tenantId, supplier.id, supplier],
            );
          },
          history: async (id) =>
            (await log.list(tenantId, id))
              .filter((e) =>
                [
                  'purchase_order.created',
                  'purchase_order.status_changed',
                ].includes(e.eventType),
              )
              .map((e): ProcurementEvent => ({
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
          submissions: (ids) =>
            documents<Submission>(
              `SELECT document FROM procurement_submissions WHERE tenant_id=$1
               AND ($2::uuid[] IS NULL OR purchase_order_id=ANY($2::uuid[])) ORDER BY created_at DESC,id DESC`,
              [tenantId, ids ?? null],
            ),
          submission: async (id) =>
            (
              await documents<Submission>(
                'SELECT document FROM procurement_submissions WHERE tenant_id=$1 AND id=$2',
                [tenantId, id],
              )
            )[0] ?? null,
          insertSubmission: async (s) => {
            await tx.query(
              `INSERT INTO procurement_submissions(tenant_id,id,purchase_order_id,connection_id,state,principal_id,document,created_at)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
              [
                tenantId,
                s.id,
                s.purchaseOrderId,
                s.connectionId,
                s.state,
                s.requestedBy,
                s,
                s.requestedAt,
              ],
            );
          },
          saveSubmission: async (s, settled) => {
            await tx.query(
              'UPDATE procurement_submissions SET state=$3,settled=$4,document=$5 WHERE tenant_id=$1 AND id=$2',
              [tenantId, s.id, s.state, settled, s],
            );
          },
          liveSubmissions: (principalId) =>
            documents<Submission>(
              `SELECT document FROM procurement_submissions WHERE tenant_id=$1 AND principal_id=$2
               AND NOT settled AND state=ANY($3::text[]) ORDER BY created_at,id`,
              [tenantId, principalId, live],
            ),
          communications: ({ orderIds, supplierId }) =>
            documents<Communication>(
              `SELECT document FROM procurement_communications WHERE tenant_id=$1
               AND ($2::uuid[] IS NULL OR purchase_order_id=ANY($2::uuid[]))
               AND ($3::uuid IS NULL OR supplier_id=$3) ORDER BY received_at DESC,id`,
              [tenantId, orderIds ?? null, supplierId ?? null],
            ),
          communication: async (id) =>
            (
              await documents<Communication>(
                'SELECT document FROM procurement_communications WHERE tenant_id=$1 AND id=$2',
                [tenantId, id],
              )
            )[0] ?? null,
          communicationByKey: async (key) =>
            (
              await documents<Communication>(
                'SELECT document FROM procurement_communications WHERE tenant_id=$1 AND message_key=$2',
                [tenantId, key],
              )
            )[0] ?? null,
          insertCommunication: async (c, key) => {
            await tx.query(
              `INSERT INTO procurement_communications(tenant_id,id,supplier_id,purchase_order_id,message_key,document,received_at,retain_until,created_at)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [
                tenantId,
                c.id,
                c.supplierId,
                c.purchaseOrderId,
                key,
                c,
                c.receivedAt,
                c.retainUntil,
                c.capturedAt,
              ],
            );
          },
          purgeCommunication: async (c) => {
            await tx.query(
              'UPDATE procurement_communications SET document=$3,purged_at=$4 WHERE tenant_id=$1 AND id=$2',
              [tenantId, c.id, c, c.purgedAt],
            );
          },
          extractions: (ids) =>
            documents<Extraction>(
              `SELECT document FROM procurement_extractions WHERE tenant_id=$1 AND communication_id=ANY($2::uuid[])
               ORDER BY communication_id,attempt`,
              [tenantId, ids],
            ),
          insertExtraction: async (e) => {
            await tx.query(
              'INSERT INTO procurement_extractions(tenant_id,id,communication_id,attempt,document,created_at) VALUES($1,$2,$3,$4,$5,$6)',
              [tenantId, e.id, e.communicationId, e.attempt, e, e.createdAt],
            );
          },
          commitments: (ids) =>
            documents<Commitment>(
              `SELECT document FROM procurement_commitments WHERE tenant_id=$1
               AND ($2::uuid[] IS NULL OR purchase_order_id=ANY($2::uuid[])) ORDER BY recorded_at,id`,
              [tenantId, ids ?? null],
            ),
          commitment: async (id) =>
            (
              await documents<Commitment>(
                'SELECT document FROM procurement_commitments WHERE tenant_id=$1 AND id=$2',
                [tenantId, id],
              )
            )[0] ?? null,
          insertCommitment: async (c, sourceKey) => {
            await tx.query(
              `INSERT INTO procurement_commitments(tenant_id,id,purchase_order_id,source_key,document,recorded_at)
               VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,source_key) DO NOTHING`,
              [tenantId, c.id, c.purchaseOrderId, sourceKey, c, c.recordedAt],
            );

            return (
              await documents<Commitment>(
                'SELECT document FROM procurement_commitments WHERE tenant_id=$1 AND source_key=$2',
                [tenantId, sourceKey],
              )
            )[0]!;
          },
          reviewCommitment: async (c) => {
            await tx.query(
              'UPDATE procurement_commitments SET document=$3 WHERE tenant_id=$1 AND id=$2',
              [tenantId, c.id, c],
            );
          },
          latestObservation: async (orderId) =>
            (
              await documents<PurchasingObservation>(
                `SELECT document FROM procurement_observations WHERE tenant_id=$1 AND purchase_order_id=$2
                 ORDER BY observed_at DESC,id DESC LIMIT 1`,
                [tenantId, orderId],
              )
            )[0] ?? null,
          observations: (orderId, limit) =>
            documents<PurchasingObservation>(
              `SELECT document FROM procurement_observations WHERE tenant_id=$1 AND purchase_order_id=$2
               ORDER BY observed_at DESC,id DESC LIMIT $3`,
              [tenantId, orderId, limit],
            ),
          insertObservation: async (o) => {
            await tx.query(
              `INSERT INTO procurement_observations(tenant_id,id,purchase_order_id,connection_id,digest,document,observed_at)
               VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
              [
                tenantId,
                o.id,
                o.purchaseOrderId,
                o.connectionId,
                o.digest,
                o,
                o.observedAt,
              ],
            );
          },
          followUps: (ids) =>
            documents<FollowUp>(
              `SELECT document FROM procurement_follow_ups WHERE tenant_id=$1
               AND ($2::uuid[] IS NULL OR purchase_order_id=ANY($2::uuid[])) ORDER BY responded_at,id`,
              [tenantId, ids ?? null],
            ),
          insertFollowUp: async (f) =>
            !!(
              await tx.query(
                `INSERT INTO procurement_follow_ups(tenant_id,id,purchase_order_id,key,document,responded_at)
                 VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
                [tenantId, f.id, f.purchaseOrderId, f.key, f, f.respondedAt],
              )
            ).rowCount,
          command: async (id) =>
            (
              await tx.query<{ digest: string; result: unknown }>(
                'SELECT digest,result FROM procurement_commands WHERE tenant_id=$1 AND id=$2',
                [tenantId, id],
              )
            ).rows[0] ?? null,
          saveCommand: async (id, digest, result) => {
            await tx.query(
              'INSERT INTO procurement_commands(tenant_id,id,digest,result) VALUES($1,$2,$3,$4)',
              [tenantId, id, digest, JSON.stringify(result)],
            );
          },
          audit: (entry) => log.append(entry),
          skuIdentities: async (connectionId, skus) => {
            // Exact canonical IDs and keys win; a SKU code counts only when one SKU has it.
            const rows = (
              await tx.query<{
                key: string;
                sku_id: string;
                rank: number;
                external_id: string;
                scope_key: string;
              }>(
                `SELECT k.key,e.id AS sku_id,
                  CASE WHEN e.id::text=k.key THEN 0 WHEN e.reconciliation_key=k.key THEN 1 ELSE 2 END AS rank,
                  m.external_id,m.scope_key
                 FROM unnest($2::text[]) k(key)
                 JOIN inventory_entities e ON e.tenant_id=$1 AND e.kind='sku' AND (e.id::text=k.key OR e.reconciliation_key=k.key
                  OR EXISTS (SELECT 1 FROM inventory_product_skus p WHERE p.tenant_id=e.tenant_id AND p.sku_id=e.id AND p.code=k.key))
                 JOIN connector_source_mappings m ON m.tenant_id=e.tenant_id AND m.resource='sku' AND m.canonical_id=e.id
                  AND m.connection_id=$3
                 ORDER BY k.key,rank,m.external_id`,
                [tenantId, skus, connectionId],
              )
            ).rows;
            const result = new Map<
              string,
              { externalId: string; scopeKey: string }
            >();
            for (const key of skus) {
              const matches = rows.filter((r) => r.key === key);
              const best = matches[0];
              if (!best) continue;
              const tied = new Set(
                matches
                  .filter((m) => m.rank === best.rank)
                  .map((m) => m.sku_id),
              );
              const externals = new Set(
                matches
                  .filter((m) => m.sku_id === best.sku_id)
                  .map((m) => `${m.scope_key}\u0000${m.external_id}`),
              );
              if (tied.size === 1 && externals.size === 1)
                result.set(key, {
                  externalId: best.external_id,
                  scopeKey: best.scope_key,
                });
            }

            return result;
          },
        });
      }),
  };
}
