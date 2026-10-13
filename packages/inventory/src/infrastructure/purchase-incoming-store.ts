import type { AuditLog } from '@luma/audit';
import type { TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import type {
  PurchaseIncomingRecord,
  PurchaseIncomingSource,
  PurchaseIncomingStore,
} from '../application/purchase-incoming.js';
import { createLedgerStore } from './ledger-store.js';

/** Keeps each supplier expectation and its balanced ledger posting in the same Inventory owner transaction. */
export function createPurchaseIncomingStore(
  db: TenantDatabase,
  audit: (db: TenantDatabase) => AuditLog,
  source: (
    db: TenantDatabase,
    context: TenantContext,
    orderId: string,
  ) => Promise<PurchaseIncomingSource | null>,
): PurchaseIncomingStore {
  return {
    transaction: (context, orderId, operation) =>
      db.transaction(context.tenantId, async (tx) => {
        const tenant = context.tenantId;
        await tx.query(
          'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',
          [`commerce-ingestion:${tenant}`],
        );
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `native-purchase-order:${tenant}:${orderId}`,
        ]);
        await tx.query(
          'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',
          [`procurement:${tenant}`],
        );
        const scoped: TenantDatabase = {
          transaction: async (_tenant, fn) => fn(tx),
        };

        return createLedgerStore(scoped, audit).transaction(
          context,
          async (ledger) =>
            operation({
              ledger,
              source: () => source(scoped, context, orderId),
              records: async () => {
                const rows = (
                  await tx.query<{
                    line_id: string;
                    sku_id: string;
                    location_id: string;
                    unit: string;
                    expected_quantity: string;
                    outstanding_quantity: string;
                    scope_version: string;
                    source_revision: string;
                    source_refs: string[];
                    observed_at: Date;
                    expected_date: string | null;
                    date_confidence: PurchaseIncomingRecord['dateConfidence'];
                    entry_id: string | null;
                  }>(
                    `SELECT line_id,sku_id,location_id,unit,trim_scale(expected_quantity)::text AS expected_quantity,trim_scale(outstanding_quantity)::text AS outstanding_quantity,scope_version::text,source_revision,source_refs,observed_at,expected_date::text,date_confidence,entry_id FROM inventory_purchase_incoming WHERE tenant_id=$1 AND purchase_order_id=$2 ORDER BY line_id FOR UPDATE`,
                    [tenant, orderId],
                  )
                ).rows;

                return rows.map((row) => ({
                  purchaseOrderId: orderId,
                  lineId: row.line_id,
                  skuId: row.sku_id,
                  locationId: row.location_id,
                  unit: row.unit,
                  expectedQuantity: row.expected_quantity,
                  outstandingQuantity: row.outstanding_quantity,
                  scopeVersion: row.scope_version,
                  sourceRevision: row.source_revision,
                  sourceRefs: row.source_refs,
                  observedAt: row.observed_at.toISOString(),
                  expectedDate: row.expected_date,
                  dateConfidence: row.date_confidence,
                  entryId: row.entry_id,
                }));
              },
              booked: async (order, lineId) => {
                const row = (
                  await tx.query<{ quantity: string }>(
                    'SELECT trim_scale(good+damaged)::text AS quantity FROM inventory_purchase_receipt_bookings WHERE tenant_id=$1 AND purchase_order_id=$2 AND line_id=$3',
                    [tenant, order, lineId],
                  )
                ).rows[0];

                return row?.quantity ?? '0';
              },
              save: async (value) => {
                await tx.query(
                  `INSERT INTO inventory_purchase_incoming(tenant_id,purchase_order_id,line_id,sku_id,location_id,unit,expected_quantity,outstanding_quantity,scope_version,source_revision,source_refs,observed_at,expected_date,date_confidence,entry_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(tenant_id,purchase_order_id,line_id) DO UPDATE SET expected_quantity=excluded.expected_quantity,outstanding_quantity=excluded.outstanding_quantity,source_revision=excluded.source_revision,source_refs=excluded.source_refs,observed_at=excluded.observed_at,expected_date=excluded.expected_date,date_confidence=excluded.date_confidence,entry_id=excluded.entry_id,updated_at=clock_timestamp()`,
                  [
                    tenant,
                    value.purchaseOrderId,
                    value.lineId,
                    value.skuId,
                    value.locationId,
                    value.unit,
                    value.expectedQuantity,
                    value.outstandingQuantity,
                    value.scopeVersion,
                    value.sourceRevision,
                    JSON.stringify(value.sourceRefs),
                    value.observedAt,
                    value.expectedDate,
                    value.dateConfidence,
                    value.entryId,
                  ],
                );
              },
            }),
        );
      }),
  };
}
