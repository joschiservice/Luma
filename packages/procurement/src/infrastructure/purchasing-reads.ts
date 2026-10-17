import type { SqlTransaction } from '@luma/platform';

import type {
  PurchasingReadEvidence,
  PurchasingWriteReceipt,
} from '../application/purchasing-reads.js';

/**
 * Stores a cited purchasing-system read in the tenant's transaction. Read IDs are unique, so a
 * repeated insert keeps the first stored read unchanged.
 */
export async function insertPurchasingRead(
  tx: SqlTransaction,
  tenantId: string,
  evidence: PurchasingReadEvidence,
) {
  await tx.query(
    `INSERT INTO procurement_read_evidence(tenant_id,id,purchase_order_id,connection_id,purpose,subject_id,observed_at,document)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [
      tenantId,
      evidence.id,
      evidence.purchaseOrderId,
      evidence.source.connectionId,
      evidence.purpose,
      evidence.subjectId,
      evidence.observedAt,
      evidence,
    ],
  );
}

/**
 * Stores the receipt of an accepted purchasing-system write in the tenant's transaction, beside
 * the reads procurement cites. A repeated insert keeps the first stored receipt unchanged.
 */
export async function insertPurchasingWriteReceipt(
  tx: SqlTransaction,
  tenantId: string,
  receipt: PurchasingWriteReceipt,
) {
  await tx.query(
    `INSERT INTO procurement_read_evidence(tenant_id,id,purchase_order_id,connection_id,purpose,subject_id,observed_at,document,kind)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'write_receipt') ON CONFLICT DO NOTHING`,
    [
      tenantId,
      receipt.id,
      receipt.purchaseOrderId,
      receipt.source.connectionId,
      receipt.purpose,
      receipt.subjectId,
      receipt.observedAt,
      receipt,
    ],
  );
}
