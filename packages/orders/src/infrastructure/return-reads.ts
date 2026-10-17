import type { SqlTransaction } from '@luma/platform';

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
