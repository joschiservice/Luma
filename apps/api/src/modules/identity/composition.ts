import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { createIdentityService } from './application/identity.js';
import { createRepository } from './infrastructure/repository.js';
import type { AuthSettings } from './infrastructure/auth.js';
import { registerAuthHandler } from './api/auth-handler.js';
export { identityRoutes, registerIdentityGuards } from './api/routes.js';
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
    register(app: FastifyInstance) {
      pool.on('error', () =>
        app.log.error('Identity database connection failed'),
      );
      registerAuthHandler(app, auth.handler, settings.baseURL);
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
