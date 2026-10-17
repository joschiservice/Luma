import type { SqlTransaction } from '@luma/platform';

/** Serializes native stock demand changes of one order until the transaction ends. Take it before `lockStockOwnership`. */
export async function lockNativeStockOrder(
  tx: SqlTransaction,
  tenantId: string,
  orderId: string,
) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `native-stock-order:${tenantId}:${orderId}`,
  ]);
}

/**
 * Holds the workspace's native order records still and keeps commerce ingestion from changing
 * projections until the transaction ends. Ingestion keeps running alongside other holders.
 */
export async function lockStockOwnership(tx: SqlTransaction, tenantId: string) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `sales:${tenantId}`,
  ]);
  await tx.query(
    'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',
    [`commerce-ingestion:${tenantId}`],
  );
}
