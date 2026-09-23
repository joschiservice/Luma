import type { Pool } from 'pg';

/** Checks identity and connector runtime grants without requiring tenant data access. */
export function createReadinessCheck(
  identityReady: () => Promise<boolean>,
  connectionPool?: Pool,
  shopify = false,
) {
  return async () => {
    if (!(await identityReady())) return false;
    if (connectionPool) {
      const result = await connectionPool.query<{ safe: boolean }>(`SELECT
          NOT r.rolsuper AND NOT r.rolbypassrls
          AND pg_has_role(current_user, 'luma_connectors', 'MEMBER')
          AND NOT EXISTS (SELECT FROM pg_class c WHERE c.oid IN ('connector_installations'::regclass, 'connector_lifecycle_events'::regclass) AND pg_has_role(current_user, c.relowner, 'MEMBER')) AS safe
          FROM pg_roles r WHERE r.rolname = current_user`);
      if (result.rows[0]?.safe !== true) return false;
      await connectionPool.query(
        'SELECT id FROM connector_installations LIMIT 0',
      );
      if (shopify) {
        await connectionPool.query(
          'SELECT digest FROM shopify_oauth_states LIMIT 0',
        );
        await connectionPool.query(
          'SELECT connection_id FROM shopify_installation_bindings LIMIT 0',
        );
      }
    }

    return true;
  };
}
