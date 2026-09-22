import type { Pool } from 'pg';

import type { TenantDatabase } from '#modules/platform/application/database';
import { measure } from '#modules/platform/application/performance';

/**
 * Runs operations in transactions with a transaction-local tenant setting; commits on
 * success and rolls back on failure.
 */
export function createTenantDatabase(pool: Pool): TenantDatabase {
  return {
    async transaction(tenantId, operation) {
      return measure('db.transaction', async () => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
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
