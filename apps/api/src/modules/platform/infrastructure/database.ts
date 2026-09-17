import type { Pool } from 'pg';
import type { TenantDatabase } from '../application/database.js';
export function createTenantDatabase(pool: Pool): TenantDatabase {
  return {
    async transaction(tenantId, operation) {
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
    },
  };
}
