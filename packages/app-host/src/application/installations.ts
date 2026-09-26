import type { TenantContext } from '@luma/identity';
import { IdentityError, requireRole, requireTenant } from '@luma/identity';

import type {
  AppFactoryContext,
  AppLifecycleContext,
  WorkspaceApp,
} from './contracts.js';
import type { AppRegistry } from './registry.js';

export interface AppRepository {
  /** Lists current and removed app installations for one tenant. */
  list(tenantId: string): Promise<WorkspaceApp[]>;
  /** Returns the active installation version, or null. */
  installed(tenantId: string, appId: string): Promise<number | null>;
  /** Atomically changes state, revokes connections on uninstall, and runs the storage hook. */
  change(
    tenantId: string,
    actorId: string,
    appId: string,
    version: number | null,
    installed: boolean,
    hook?: (context: AppLifecycleContext) => Promise<void>,
  ): Promise<WorkspaceApp>;
}

/** Authorizes workspace app lifecycle changes and rejects use of unavailable installations. */
export function createAppService(
  repository: AppRepository,
  registry: AppRegistry,
  refreshContext: AppFactoryContext['refreshContext'],
) {
  async function authorize(context: TenantContext, manage = false) {
    const fresh = await refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (manage) requireRole(fresh, ['owner', 'admin']);

    return fresh;
  }

  async function change(
    context: TenantContext,
    appId: string,
    version: number | null,
    installed: boolean,
  ) {
    const fresh = await authorize(context, true);
    const app = registry.get(appId);
    if (installed && !app)
      throw new IdentityError(404, 'NOT_FOUND', 'App is unavailable');

    return repository.change(
      fresh.tenantId,
      fresh.actor.id,
      appId,
      version,
      installed,
      installed ? app?.installed : app?.uninstalled,
    );
  }

  return {
    /** Lists available metadata and historical installation state after refreshing membership. */
    async list(context: TenantContext) {
      const fresh = await authorize(context);

      return {
        catalog: registry.list(),
        installations: await repository.list(fresh.tenantId),
      };
    },
    /** Installs or reinstalls an available app; requires an owner or admin. */
    install: (context: TenantContext, appId: string, version: number | null) =>
      change(context, appId, version, true),
    /** Revokes all app connections while preserving history; requires the current version. */
    uninstall: (context: TenantContext, appId: string, version: number) =>
      change(context, appId, version, false),
    /** Returns the active installation version; rejects absent packages and uninstalled apps. */
    async requireInstalled(context: TenantContext, appId: string) {
      requireTenant(context, context.tenantId);
      if (!registry.get(appId))
        throw new IdentityError(404, 'NOT_FOUND', 'App is unavailable');
      const version = await repository.installed(context.tenantId, appId);
      if (version === null)
        throw new IdentityError(
          409,
          'CONFLICT',
          'Install this app in the workspace first',
        );

      return version;
    },
  };
}

export type AppService = ReturnType<typeof createAppService>;
