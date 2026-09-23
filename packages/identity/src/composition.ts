import { Pool } from 'pg';

import { createIdentityService } from './application/identity.js';
import type { AuthSettings } from './infrastructure/auth.js';
import { createRepository } from './infrastructure/repository.js';

/**
 * Creates identity services, an authentication handler, and readiness checks. Call close to
 * release the owned database pool.
 */
export function createIdentity(
  settings: AuthSettings & { databaseUrl: string },
) {
  const pool = new Pool({
    connectionString: settings.databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    idle_in_transaction_session_timeout: 10000,
  });
  const { repository, auth } = createRepository(pool, settings);

  return {
    service: createIdentityService(repository),
    trustedOrigins: settings.trustedOrigins,
    handler: auth.handler,
    baseURL: settings.baseURL,
    /** Registers an idle database connection error handler without coupling identity to HTTP. */
    onDatabaseError(handler: () => void) {
      pool.on('error', handler);
    },
    async checkReadiness() {
      const result = await pool.query<{ safe: boolean }>(`SELECT
        NOT r.rolsuper AND NOT r.rolbypassrls
        AND pg_has_role(current_user, 'luma_identity', 'MEMBER')
        AND NOT EXISTS (SELECT FROM pg_class c WHERE c.oid IN ('users'::regclass, 'organizations'::regclass, 'memberships'::regclass) AND pg_has_role(current_user, c.relowner, 'MEMBER')) AS safe
        FROM pg_roles r WHERE r.rolname = current_user`);
      await pool.query('SELECT id FROM sessions LIMIT 0');

      return result.rows[0]?.safe === true;
    },
    async close() {
      await pool.end();
    },
  };
}

export { makeTenantContext } from './domain/context.js';
