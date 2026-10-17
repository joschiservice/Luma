import type { AppPermissionGroup, TenantContext } from '@luma/identity';
import {
  appPermissionOwner,
  hasPermission,
  isPermission,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import { conflict, forbidden, notFound, ServiceError } from '@luma/platform';

import type {
  AppFactoryContext,
  AppLifecycleContext,
  AppManifest,
  AppOperation,
  WorkspaceApp,
} from './contracts.js';
import type { AppRegistry } from './registry.js';

/** The manifest facts an installation keeps, so roles can show app permissions without code. */
export interface InstalledManifest {
  version: string | null;
  name: string;
  permissions: AppManifest['permissions'];
}

export interface AppRepository {
  /** Lists current and removed app installations for one tenant. */
  list(tenantId: string): Promise<WorkspaceApp[]>;
  /** Returns the active installation version and its granted scopes, or null. */
  installed(
    tenantId: string,
    appId: string,
  ): Promise<{ version: number; scopes: string[] } | null>;
  /** Lists active installations with the manifest data they registered. */
  manifests(
    tenantId: string,
  ): Promise<{ appId: string; manifest: InstalledManifest }[]>;
  /** Lists active roles holding the app's permissions. */
  roles(
    tenantId: string,
    appId: string,
  ): Promise<{ id: string; name: string; permissions: number }[]>;
  /**
   * Atomically changes state and runs the storage hook. Installing stores the manifest and
   * grants `scopes`; uninstalling revokes connections, scopes and the app's role permissions.
   */
  change(
    tenantId: string,
    actorId: string,
    appId: string,
    version: number | null,
    installed: boolean,
    grant?: { manifest: InstalledManifest; scopes: string[] },
    hook?: (context: AppLifecycleContext) => Promise<void>,
  ): Promise<WorkspaceApp>;
  /** Grants more scopes to the installation at `version`; returns the updated installation. */
  grant(
    tenantId: string,
    actorId: string,
    appId: string,
    version: number,
    scopes: string[],
  ): Promise<WorkspaceApp>;
}

const snapshot = (manifest: AppManifest): InstalledManifest => ({
  version: manifest.version,
  name: manifest.name,
  permissions: structuredClone(manifest.permissions),
});

/**
 * Authorizes workspace app lifecycle changes, scope consent and app operations, and rejects use
 * of unavailable installations.
 */
export function createAppService(
  repository: AppRepository,
  registry: AppRegistry,
  refreshContext: AppFactoryContext['refreshContext'],
) {
  async function authorize(context: TenantContext, manage = false) {
    const fresh = await refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (manage) requirePermission(fresh, 'apps.manage');

    return fresh;
  }

  /** People can only grant an app scopes they hold themselves. */
  function requireScopes(context: TenantContext, scopes: readonly string[]) {
    const missing = scopes.filter(
      (scope) => !isPermission(scope) || !hasPermission(context, scope),
    );
    if (missing.length)
      throw forbidden(
        `You can only grant access you have yourself. Missing: ${missing.join(', ')}.`,
      );
  }

  async function installation(context: TenantContext, appId: string) {
    requireTenant(context, context.tenantId);
    if (!registry.get(appId)) throw notFound('App is unavailable');
    const current = await repository.installed(context.tenantId, appId);
    if (!current) throw conflict('Install this app in the workspace first');

    return current;
  }

  /** Checks one operation; see `AppFactoryContext.requirePermission`. */
  async function operation(context: TenantContext, request: AppOperation) {
    const current = await installation(context, request.app);
    const { permission } = request;
    if (permission !== undefined) {
      const owner = appPermissionOwner(permission);
      if (owner !== null) {
        if (
          owner !== request.app ||
          !registry
            .get(request.app)!
            .manifest.permissions.some((item) => item.key === permission)
        )
          throw forbidden(`${permission} is not a permission of this app.`);
        if (!context.permissions.has(permission))
          throw forbidden(
            'Your role does not allow this app action. Ask a workspace admin for access.',
          );
      } else if (!isPermission(permission))
        throw forbidden(`${permission} is not a known permission.`);
      else requirePermission(context, permission);
    }
    for (const scope of request.scopes ?? []) {
      if (!current.scopes.includes(scope))
        throw forbidden(
          `This app has not been granted ${scope}. Ask a workspace admin to review the app’s access.`,
        );
      if (!context.permissions.has(scope))
        throw forbidden(
          'Your role does not allow this app action. Ask a workspace admin for access.',
        );
    }

    return current;
  }

  async function change(
    context: TenantContext,
    appId: string,
    version: number | null,
    installed: boolean,
    scopes: readonly string[] = [],
  ) {
    const fresh = await authorize(context, true);
    const app = registry.get(appId);
    if (installed && !app) throw notFound('App is unavailable');
    if (installed) {
      const requested = new Set(app!.manifest.scopes);
      if (
        scopes.length !== requested.size ||
        !scopes.every((scope) => requested.has(scope))
      )
        throw conflict(
          'The access this app requests changed. Review it again before installing.',
        );
      requireScopes(fresh, scopes);
    }

    return repository.change(
      fresh.tenantId,
      fresh.actor.id,
      appId,
      version,
      installed,
      installed
        ? { manifest: snapshot(app!.manifest), scopes: [...scopes] }
        : undefined,
      installed ? app?.installed : app?.uninstalled,
    );
  }

  return {
    /**
     * Lists available metadata and installation state after refreshing membership, with the
     * scopes each installation was granted, scopes an upgrade still needs approved, and roles
     * that would lose permissions on uninstall.
     */
    async list(context: TenantContext) {
      const fresh = await authorize(context);
      const installations = await repository.list(fresh.tenantId);

      return {
        catalog: registry.list(),
        installations: await Promise.all(
          installations.map(async (item) => {
            const manifest = registry.get(item.appId)?.manifest;

            return {
              ...item,
              pendingScopes:
                item.status === 'installed' && manifest
                  ? manifest.scopes.filter(
                      (scope) => !item.grantedScopes.includes(scope),
                    )
                  : [],
              roles:
                item.status === 'installed'
                  ? await repository.roles(fresh.tenantId, item.appId)
                  : [],
            };
          }),
        ),
      };
    },
    /**
     * Installs or reinstalls an available app and grants exactly the scopes its manifest
     * requests. Requires `apps.manage` and every requested scope. Reinstalls start without role
     * permissions.
     */
    install: (
      context: TenantContext,
      appId: string,
      version: number | null,
      scopes: readonly string[],
    ) => change(context, appId, version, true, scopes),
    /**
     * Revokes all app connections, scope grants and the app's permissions in every role while
     * preserving history; requires the current version.
     */
    uninstall: (context: TenantContext, appId: string, version: number) =>
      change(context, appId, version, false),
    /** Grants scopes an upgraded app requests; existing grants keep working until then. */
    async approveScopes(
      context: TenantContext,
      appId: string,
      version: number,
      scopes: readonly string[],
    ) {
      const fresh = await authorize(context, true);
      const app = registry.get(appId);
      if (!app) throw notFound('App is unavailable');
      const unknown = scopes.filter(
        (scope) => !app.manifest.scopes.includes(scope),
      );
      if (unknown.length || !scopes.length)
        throw conflict(
          'The access this app requests changed. Review it again.',
        );
      requireScopes(fresh, scopes);

      return repository.grant(fresh.tenantId, fresh.actor.id, appId, version, [
        ...scopes,
      ]);
    },
    /** Returns the active installation version; rejects absent packages and uninstalled apps. */
    async requireInstalled(context: TenantContext, appId: string) {
      return (await installation(context, appId)).version;
    },
    /** Requires an app operation for a person; see `AppFactoryContext.requirePermission`. */
    async requirePermission(context: TenantContext, request: AppOperation) {
      await operation(context, request);
    },
    /** Reports whether `requirePermission` would allow the operation. */
    async hasPermission(context: TenantContext, request: AppOperation) {
      try {
        await operation(context, request);

        return true;
      } catch (error) {
        if (error instanceof ServiceError) return false;
        throw error;
      }
    },
    /** Requires the installation to hold scopes, regardless of the person; for host checks. */
    async requireGranted(
      context: TenantContext,
      appId: string,
      scopes: readonly string[],
    ) {
      const current = await installation(context, appId);
      const missing = scopes.filter((scope) => !current.scopes.includes(scope));
      if (missing.length)
        throw forbidden(
          `This app has not been granted ${missing.join(', ')}. Ask a workspace admin to review the app’s access.`,
        );
    },
    /** Reports whether an app is installed and available, for host-owned filtering. */
    async installed(context: TenantContext, appId: string) {
      return (
        !!registry.get(appId) &&
        (await repository.installed(context.tenantId, appId)) !== null
      );
    },
    /**
     * Lists permission definitions of installed apps for role editors. Apps whose package is
     * missing are listed as unavailable with the definitions they registered.
     */
    async permissions(tenantId: string): Promise<AppPermissionGroup[]> {
      return (await repository.manifests(tenantId)).map(
        ({ appId, manifest }) => {
          const current = registry.get(appId)?.manifest;
          const declared = current?.permissions ?? manifest.permissions;

          return {
            app: {
              id: appId,
              name: current?.name ?? manifest.name,
              available: !!current,
            },
            permissions: structuredClone(declared),
          };
        },
      );
    },
  };
}

export type AppService = ReturnType<typeof createAppService>;
