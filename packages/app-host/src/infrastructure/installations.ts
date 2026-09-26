import type { TenantDatabase } from '@luma/platform';

import type {
  AppLifecycleContext,
  WorkspaceApp,
} from '../application/contracts.js';
import { nextInstallation } from '../domain/installation.js';

/** Provides tenant-scoped, atomic app state and connection revocation storage. */
export function createAppRepository(database: TenantDatabase) {
  return {
    async list(tenantId: string): Promise<WorkspaceApp[]> {
      return database.transaction(tenantId, async (tx) =>
        (
          await tx.query<{
            app_id: string;
            status: WorkspaceApp['status'];
            version: number;
            updated_at: Date;
          }>(
            'SELECT app_id,status,version,updated_at FROM workspace_apps WHERE tenant_id=$1 ORDER BY app_id',
            [tenantId],
          )
        ).rows.map((row) => ({
          appId: row.app_id,
          status: row.status,
          version: row.version,
          updatedAt: row.updated_at.toISOString(),
        })),
      );
    },
    async installed(tenantId: string, appId: string): Promise<number | null> {
      return database.transaction(
        tenantId,
        async (tx) =>
          (
            await tx.query<{ version: number }>(
              "SELECT version FROM workspace_apps WHERE tenant_id=$1 AND app_id=$2 AND status='installed'",
              [tenantId, appId],
            )
          ).rows[0]?.version ?? null,
      );
    },
    async change(
      tenantId: string,
      actorId: string,
      appId: string,
      version: number | null,
      installed: boolean,
      hook?: (context: AppLifecycleContext) => Promise<void>,
    ): Promise<WorkspaceApp> {
      return database.transaction(tenantId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          JSON.stringify(['workspace-app', tenantId, appId]),
        ]);
        const existing = (
          await tx.query<{
            app_id: string;
            status: WorkspaceApp['status'];
            version: number;
          }>(
            'SELECT app_id,status,version FROM workspace_apps WHERE tenant_id=$1 AND app_id=$2 FOR UPDATE',
            [tenantId, appId],
          )
        ).rows[0];
        const state = nextInstallation(existing, appId, version, installed);
        await tx.query(
          'INSERT INTO workspace_apps(tenant_id,app_id,status,version,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,app_id) DO UPDATE SET status=$3,version=$4,updated_at=$5',
          [tenantId, appId, state.status, state.version, state.updatedAt],
        );
        if (!installed) {
          const rows = (
            await tx.query<{
              id: string;
              version: number;
              document: { credentialVersion: number };
            }>(
              `UPDATE connector_installations SET version=version+1, secret=NULL, document=document || jsonb_build_object('status','disconnected','granted','[]'::jsonb,'version',version+1,'updatedAt',$3::text) WHERE tenant_id=$1 AND document->>'appId'=$2 AND document->>'status' NOT IN ('disconnected','revoked') RETURNING id,version,document`,
              [tenantId, appId, state.updatedAt],
            )
          ).rows;
          for (const row of rows)
            await tx.query(
              "INSERT INTO connector_lifecycle_events(tenant_id,connection_id,version,event,actor_id,status,credential_version) VALUES($1,$2,$3,'app_uninstalled',$4,'disconnected',$5)",
              [
                tenantId,
                row.id,
                row.version,
                actorId,
                row.document.credentialVersion,
              ],
            );
        }
        await hook?.({
          tenantId,
          actorId,
          version: state.version,
          transaction: tx,
        });
        await tx.query(
          'INSERT INTO workspace_app_events(tenant_id,app_id,version,status,actor_id) VALUES($1,$2,$3,$4,$5)',
          [tenantId, appId, state.version, state.status, actorId],
        );

        return state;
      });
    },
  };
}
