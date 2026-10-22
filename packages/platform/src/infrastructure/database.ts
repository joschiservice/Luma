import type { Pool } from 'pg';

import type { TenantDatabase } from '../application/database.js';
import { measure } from '../application/performance.js';

/**
 * Runs operations in transactions with a transaction-local tenant setting; commits on
 * success and rolls back on failure. While `readOnly` reports true, for example in a request
 * restricted to reads, every transaction is `READ ONLY`. When no connection is acquired in
 * time, it throws an error naming the pool's open, idle and waiting counts.
 */
export function createTenantDatabase(
  pool: Pool,
  settings: { readOnly?: () => boolean } = {},
): TenantDatabase {
  return {
    async transaction(tenantId, operation, options) {
      return measure('db.transaction', async () => {
        const client = await pool.connect().catch((error: unknown) => {
          // Failure reports carry the pool's occupancy, so saturation is visible where
          // metrics are not exported.
          throw new Error(
            `Database connection unavailable (${pool.totalCount} open, ${pool.idleCount} idle, ${pool.waitingCount} waiting)`,
            { cause: error },
          );
        });
        try {
          const begin = options?.readOnlySnapshot
            ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
            : settings.readOnly?.()
              ? 'BEGIN READ ONLY'
              : 'BEGIN';
          // One round trip opens the transaction and scopes it to the tenant. A query with
          // several statements takes no parameters, so the tenant ID is an escaped literal.
          await client.query(
            `${begin}; SELECT set_config('app.tenant_id', ${client.escapeLiteral(tenantId)}, true)`,
          );
          const result = await operation(client);
          await client.query('COMMIT');

          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      });
    },
  };
}
