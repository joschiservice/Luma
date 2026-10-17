import type { TenantDatabase } from '@luma/platform';

import type { InstalledConnection } from '../domain/installation.js';

/**
 * Credential-free reads of installed connections for other owners: who installed each
 * connection and an installation's public document. Never reads secrets.
 */
export function createConnectionDirectory(database: TenantDatabase) {
  return {
    /** The member who installed each connection, from its first lifecycle event. */
    async installers(tenantId: string, connectionIds: string[]) {
      if (!connectionIds.length) return new Map<string, string>();

      return database.transaction(
        tenantId,
        async (tx) =>
          new Map(
            (
              await tx.query<{ connection_id: string; actor_id: string }>(
                `SELECT DISTINCT ON (connection_id) connection_id,actor_id FROM connector_lifecycle_events
            WHERE tenant_id=$1 AND connection_id=ANY($2::uuid[]) ORDER BY connection_id,version`,
                [tenantId, connectionIds],
              )
            ).rows.map((row) => [row.connection_id, row.actor_id]),
          ),
      );
    },
    /**
     * The stored public document of one installation, or undefined. Callers validate the fields
     * they rely on: stored documents may predate the current shape.
     */
    async installation(
      tenantId: string,
      connectionId: string,
    ): Promise<unknown> {
      return (
        await database.transaction(tenantId, (tx) =>
          tx.query<{ document: InstalledConnection }>(
            'SELECT document FROM connector_installations WHERE tenant_id=$1 AND id=$2',
            [tenantId, connectionId],
          ),
        )
      ).rows[0]?.document;
    },
  };
}
