import type { TenantDatabase } from '@luma/platform';
import { conflict } from '@luma/platform';

import type { InstallationRepository } from '../../application/installations.js';
import type { InstalledConnection } from '../../domain/installation.js';

/**
 * Creates tenant-scoped installation storage with version checks and lifecycle-event
 * persistence.
 */
export function createInstallationRepository(
  db: TenantDatabase,
): InstallationRepository {
  return {
    list: (tenantId) =>
      db.transaction(tenantId, async (tx) => {
        const result = await tx.query<{ document: InstalledConnection }>(
          'SELECT document FROM connector_installations WHERE tenant_id=$1 ORDER BY id',
          [tenantId],
        );

        return result.rows.map((row) => row.document);
      }),
    get: (tenantId, id) =>
      db.transaction(tenantId, async (tx) => {
        const result = await tx.query<{
          document: InstalledConnection;
          secret: string | null;
        }>(
          'SELECT document,secret FROM connector_installations WHERE tenant_id=$1 AND id=$2',
          [tenantId, id],
        );
        const row = result.rows[0];

        return row ? { connection: row.document, secret: row.secret } : null;
      }),
    save: (record, expectedVersion, actorId, event) =>
      db.transaction(record.connection.tenantId, async (tx) => {
        const c = record.connection;
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `exceptions:${c.tenantId}`,
        ]);
        // Lock app state before connection rows, matching uninstall and OAuth refresh.
        if (c.appId && c.appInstallationVersion)
          await tx.query(
            'SELECT app_id FROM workspace_apps WHERE tenant_id=$1 AND app_id=$2 FOR SHARE',
            [c.tenantId, c.appId],
          );
        const before = (
          await tx.query<{ document: InstalledConnection }>(
            'SELECT document FROM connector_installations WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
            [c.tenantId, c.id],
          )
        ).rows[0]?.document;
        if (before?.provider === 'luma-erp')
          throw conflict('Built-in source is managed by Luma');
        const result =
          expectedVersion === null
            ? await tx.query(
                'INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',
                [c.tenantId, c.id, c.version, c, record.secret],
              )
            : await tx.query(
                'UPDATE connector_installations SET version=$3,document=$4,secret=$5 WHERE tenant_id=$1 AND id=$2 AND version=$6 RETURNING id',
                [
                  c.tenantId,
                  c.id,
                  c.version,
                  c,
                  record.secret,
                  expectedVersion,
                ],
              );
        if (result.rowCount !== 1) return false;
        await tx.query(
          'INSERT INTO connector_lifecycle_events(tenant_id,connection_id,version,event,actor_id,status,credential_version,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            c.tenantId,
            c.id,
            c.version,
            event,
            actorId,
            c.status,
            c.credentialVersion,
            { writeMode: before?.writeMode ?? null },
            { writeMode: c.writeMode ?? null },
          ],
        );

        return true;
      }),
  };
}
