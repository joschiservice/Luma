import type { Pool, PoolClient } from 'pg';

import type {
  AccountInspections,
  InspectionChange,
} from '../application/account-inspections.js';
import type { InspectionRow } from './settings.js';
import { inspectionDto, inspectionSelect, openInspection } from './settings.js';

/**
 * Stores account inspection answers on the identity pool. Each call runs in a transaction scoped
 * to the account by row security; the request ID is recorded with the security event.
 */
export function createAccountInspections(pool: Pool): AccountInspections {
  async function scoped<T>(
    userId: string,
    requestId: string,
    operation: (tx: PoolClient) => Promise<T>,
  ) {
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query(
        "SELECT set_config('app.user_id',$1,true),set_config('app.request_id',$2,true)",
        [userId, requestId],
      );
      const result = await operation(tx);
      await tx.query('COMMIT');

      return result;
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally {
      tx.release();
    }
  }

  /** Reports whether a request already holds the state a retried change would set. */
  async function settled(
    tx: PoolClient,
    userId: string,
    id: string,
    status: string,
  ): Promise<InspectionChange> {
    const row = (
      await tx.query<{ status: string }>(
        'SELECT status FROM account_inspection_requests WHERE user_id=$1 AND id=$2',
        [userId, id],
      )
    ).rows[0];

    return row?.status === status ? 'unchanged' : 'conflict';
  }

  return {
    list: (userId) =>
      scoped(userId, 'account-inspections', async (tx) =>
        (
          await tx.query<InspectionRow>(
            `${inspectionSelect} FROM account_inspection_requests WHERE user_id=$1 AND ${openInspection} ORDER BY requested_at DESC LIMIT 20`,
            [userId],
          )
        ).rows.map(inspectionDto),
      ),
    decide: (userId, id, status, requestId) =>
      scoped(userId, requestId, async (tx) => {
        // A trigger enforces the lifecycle, sets the access window and records the answer.
        const result = await tx.query(
          "UPDATE account_inspection_requests SET status=$3,decided_by=$1 WHERE user_id=$1 AND id=$2 AND status='pending' AND expires_at>now()",
          [userId, id, status],
        );

        return result.rowCount ? 'changed' : settled(tx, userId, id, status);
      }),
    revoke: (userId, id, requestId) =>
      scoped(userId, requestId, async (tx) => {
        const result = await tx.query(
          "UPDATE account_inspection_requests SET status='revoked',revoked_by=$1 WHERE user_id=$1 AND id=$2 AND status='approved' AND mode='consent' AND access_expires_at>now()",
          [userId, id],
        );

        return result.rowCount ? 'changed' : settled(tx, userId, id, 'revoked');
      }),
  };
}
