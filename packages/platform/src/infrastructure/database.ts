import type { Pool } from 'pg';

import type { TenantDatabase } from '../application/database.js';
import { measure } from '../application/performance.js';

/**
 * Runs operations in transactions with a transaction-local tenant setting; commits on
 * success and rolls back on failure. While `readOnly` reports true, for example in a request
 * restricted to reads, every transaction is `READ ONLY`.
 */
export function createTenantDatabase(
  pool: Pool,
  settings: { readOnly?: () => boolean } = {},
): TenantDatabase {
  return {
    async transaction(tenantId, operation, options) {
      return measure('db.transaction', async () => {
        const client = await pool.connect();
        try {
          await client.query(
            options?.readOnlySnapshot
              ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
              : settings.readOnly?.()
                ? 'BEGIN READ ONLY'
                : 'BEGIN',
          );
          await client.query("SELECT set_config('app.tenant_id', $1, true)", [
            tenantId,
          ]);
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
