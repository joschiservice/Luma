import type { PlaybookGrantReader } from '#modules/connectors/application/playbook-grants';
import type { InstalledConnection } from '#modules/connectors/domain/installation';
import { requireTenant } from '#modules/identity/index';
import type { TenantDatabase } from '#modules/platform/index';

/** Reads tenant-owned connection grants and canonical order mappings without credentials. */
export function createPlaybookGrantReader(
  db: TenantDatabase,
): PlaybookGrantReader {
  return (context, lock) => {
    requireTenant(context, context.tenantId);

    return db.transaction(context.tenantId, async (tx) => {
      const connections = await tx.query<{ document: InstalledConnection }>(
        `SELECT document FROM connector_installations WHERE tenant_id=$1 ORDER BY id${lock ? ' FOR SHARE' : ''}`,
        [context.tenantId],
      );
      const targets = await tx.query<{
        connection_id: string;
        id: string;
        label: string;
      }>(
        `SELECT connection_id, canonical_id AS id, min(external_id) AS label FROM connector_source_mappings WHERE tenant_id=$1 AND resource='order' GROUP BY connection_id, canonical_id ORDER BY connection_id, canonical_id`,
        [context.tenantId],
      );

      return connections.rows.map(({ document }) => ({
        connection: document,
        targets: targets.rows
          .filter((t) => t.connection_id === document.id)
          .map(({ id, label }) => ({ id, label })),
      }));
    });
  };
}
