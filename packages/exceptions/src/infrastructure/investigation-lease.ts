import type { SqlTransaction } from '@luma/platform';

/**
 * Takes the incident's investigation lease for the rest of the transaction without waiting.
 * Returns false when another investigation of the same incident holds it.
 */
export async function tryLeaseDiagnosisInvestigation(
  tx: SqlTransaction,
  tenantId: string,
  exceptionId: string,
) {
  const lease = (
    await tx.query<{ admitted: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS admitted',
      [`diagnosis-investigation:${tenantId}:${exceptionId}`],
    )
  ).rows[0];

  return lease?.admitted === true;
}
