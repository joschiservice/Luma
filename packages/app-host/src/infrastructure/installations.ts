import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import { conflict } from '@luma/platform';

import type {
  AppLifecycleContext,
  WorkspaceApp,
} from '../application/contracts.js';
import type {
  AppRepository,
  InstalledManifest,
} from '../application/installations.js';
import { nextInstallation } from '../domain/installation.js';

async function scopes(tx: SqlTransaction, tenantId: string, appId: string) {
  return (
    await tx.query<{ scope: string }>(
      'SELECT scope FROM workspace_app_scopes WHERE tenant_id=$1 AND app_id=$2 ORDER BY scope',
      [tenantId, appId],
    )
  ).rows.map((row) => row.scope);
}

/** Provides tenant-scoped, atomic app state, scope grants and connection revocation storage. */
export function createAppRepository(database: TenantDatabase): AppRepository {
  return {
    async list(tenantId) {
      return database.transaction(tenantId, async (tx) =>
        (
          await tx.query<{
            app_id: string;
            status: WorkspaceApp['status'];
            version: number;
            updated_at: Date;
            scopes: string[];
          }>(
            `SELECT a.app_id,a.status,a.version,a.updated_at,
            ARRAY(SELECT s.scope FROM workspace_app_scopes s WHERE s.tenant_id=a.tenant_id AND s.app_id=a.app_id ORDER BY s.scope) AS scopes
            FROM workspace_apps a WHERE a.tenant_id=$1 ORDER BY a.app_id`,
            [tenantId],
          )
        ).rows.map((row) => ({
          appId: row.app_id,
          status: row.status,
          version: row.version,
          updatedAt: row.updated_at.toISOString(),
          grantedScopes: row.scopes,
        })),
      );
    },
    async installed(tenantId, appId) {
      return database.transaction(tenantId, async (tx) => {
        const row = (
          await tx.query<{ version: number; scopes: string[] }>(
            `SELECT a.version,ARRAY(SELECT s.scope FROM workspace_app_scopes s WHERE s.tenant_id=a.tenant_id AND s.app_id=a.app_id) AS scopes
            FROM workspace_apps a WHERE a.tenant_id=$1 AND a.app_id=$2 AND a.status='installed'`,
            [tenantId, appId],
          )
        ).rows[0];

        return row ? { version: row.version, scopes: row.scopes } : null;
      });
    },
    async manifests(tenantId) {
      return database.transaction(tenantId, async (tx) =>
        (
          await tx.query<{
            app_id: string;
            manifest: Partial<InstalledManifest>;
          }>(
            "SELECT app_id,manifest FROM workspace_apps WHERE tenant_id=$1 AND status='installed' ORDER BY app_id",
            [tenantId],
          )
        ).rows.map((row) => ({
          appId: row.app_id,
          manifest: {
            version: row.manifest.version ?? null,
            name: row.manifest.name ?? row.app_id,
            permissions: row.manifest.permissions ?? [],
          },
        })),
      );
    },
    async roles(tenantId, appId) {
      return database.transaction(tenantId, async (tx) =>
        (
          await tx.query<{
            role_id: string;
            name: string;
            permissions: number;
          }>(
            'SELECT role_id,name,permissions FROM app_permission_roles($1,$2)',
            [tenantId, appId],
          )
        ).rows.map((row) => ({
          id: row.role_id,
          name: row.name,
          permissions: row.permissions,
        })),
      );
    },
    async change(tenantId, actorId, appId, version, installed, grant, hook) {
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
          `INSERT INTO workspace_apps(tenant_id,app_id,status,version,updated_at,manifest) VALUES($1,$2,$3,$4,$5,COALESCE($6::jsonb,'{"version":null,"permissions":[],"scopes":[]}'::jsonb))
          ON CONFLICT(tenant_id,app_id) DO UPDATE SET status=$3,version=$4,updated_at=$5,manifest=COALESCE($6::jsonb,workspace_apps.manifest)`,
          [
            tenantId,
            appId,
            state.status,
            state.version,
            state.updatedAt,
            grant ? JSON.stringify(grant.manifest) : null,
          ],
        );
        // Every installation starts from its own consent; earlier grants never carry over.
        await tx.query(
          'DELETE FROM workspace_app_scopes WHERE tenant_id=$1 AND app_id=$2',
          [tenantId, appId],
        );
        if (grant?.scopes.length)
          await tx.query(
            `INSERT INTO workspace_app_scopes(tenant_id,app_id,scope,installation_version,granted_by)
            SELECT $1,$2,unnest($3::text[]),$4,$5`,
            [tenantId, appId, grant.scopes, state.version, actorId],
          );
        if (!installed) {
          // Roles lose the app's permissions in this transaction; a reinstall restores none.
          await tx.query(
            'SELECT 1 FROM revoke_app_role_permissions($1,$2,$3,$4)',
            [tenantId, appId, actorId, state.version],
          );
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
        } satisfies AppLifecycleContext);
        await tx.query(
          'INSERT INTO workspace_app_events(tenant_id,app_id,version,status,actor_id) VALUES($1,$2,$3,$4,$5)',
          [tenantId, appId, state.version, state.status, actorId],
        );

        return { ...state, grantedScopes: grant?.scopes.sort() ?? [] };
      });
    },
    async grant(tenantId, actorId, appId, version, granted) {
      return database.transaction(tenantId, async (tx) => {
        const current = (
          await tx.query<{ version: number; updated_at: Date }>(
            "SELECT version,updated_at FROM workspace_apps WHERE tenant_id=$1 AND app_id=$2 AND status='installed' FOR UPDATE",
            [tenantId, appId],
          )
        ).rows[0];
        if (!current || current.version !== version)
          throw conflict('App installation changed; refresh and retry');
        await tx.query(
          `INSERT INTO workspace_app_scopes(tenant_id,app_id,scope,installation_version,granted_by)
          SELECT $1,$2,unnest($3::text[]),$4,$5 ON CONFLICT DO NOTHING`,
          [tenantId, appId, granted, version, actorId],
        );

        return {
          appId,
          status: 'installed' as const,
          version,
          updatedAt: current.updated_at.toISOString(),
          grantedScopes: await scopes(tx, tenantId, appId),
        };
      });
    },
  };
}
