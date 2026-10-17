import type { SqlTransaction } from '@luma/platform';

import type { ReturnWriteReceipt } from '../application/return-write-receipts.js';
import type { ReturnReadEvidence } from '../domain/return-reads.js';

/**
 * Stores a cited provider read in the tenant's transaction. Read IDs are unique, so a repeated
 * insert keeps the first stored read unchanged; the table accepts no updates or deletes.
 */
export async function insertReturnRead(
  tx: SqlTransaction,
  tenantId: string,
  evidence: ReturnReadEvidence,
) {
  await tx.query(
    `INSERT INTO orders_return_read_evidence(tenant_id,id,case_id,connection_id,purpose,subject_id,observed_at,document)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [
      tenantId,
      evidence.id,
      evidence.caseId,
      evidence.source.connectionId,
      evidence.purpose,
      evidence.subjectId,
      evidence.observedAt,
      evidence,
    ],
  );
}

/**
 * Stores the receipt of an accepted return write in the tenant's transaction, beside the case's
 * cited reads. A repeated insert keeps the first stored receipt unchanged.
 */
export async function insertReturnWriteReceipt(
  tx: SqlTransaction,
  tenantId: string,
  receipt: ReturnWriteReceipt,
) {
  await tx.query(
    `INSERT INTO orders_return_read_evidence(tenant_id,id,case_id,connection_id,purpose,subject_id,observed_at,document,kind)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'write_receipt') ON CONFLICT DO NOTHING`,
    [
      tenantId,
      receipt.id,
      receipt.caseId,
      receipt.source.connectionId,
      receipt.purpose,
      receipt.subjectId,
      receipt.observedAt,
      receipt,
    ],
  );
}
