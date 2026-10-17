import type { SqlTransaction } from '@luma/platform';

import type { PurchasingReadEvidence } from '../application/purchasing-reads.js';

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
