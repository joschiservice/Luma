import type { RouteAccess } from '@luma/api-contract';
import type { ConnectionProvider } from '@luma/connections';
import type { IdentityService, TenantContext } from '@luma/identity';
import type { FastifyInstance } from 'fastify';

import { validateManifest } from '../domain/manifest.js';
import type { AppDefinition, AppOperation } from './contracts.js';

/** Checks an app operation for a person against installation, grants and scopes. */
export type AppAuthorizer = (
  context: TenantContext,
  operation: AppOperation,
) => Promise<void>;

/**
 * Validates unique app and connection identities and app permission data, and exposes immutable
 * registration snapshots.
 */
export function createAppRegistry(
  definitions: readonly AppDefinition[] = [],
  options: {
    /**
     * Runs before a connector builds a write capability, so the host can require the app's
     * `actions.execute` scope. The person's permission is checked by policy evaluation.
     */
    beforeWrite?(context: TenantContext, appId: string): Promise<void>;
  } = {},
) {
  const apps = new Map<string, AppDefinition>();
  const targets = new Map<string, ConnectionProvider>();
  for (const definition of definitions) {
    const { manifest, connector } = definition;
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(manifest.id) || apps.has(manifest.id))
      throw new Error('Invalid or duplicate app ID');
    if (connector && connector.appId !== manifest.id)
      throw new Error('Connector belongs to a different app');
    validateManifest(manifest);
    const snapshot = { ...definition, manifest: structuredClone(manifest) };
    apps.set(manifest.id, snapshot);
    for (const target of connector?.targets ?? []) {
      if (targets.has(target)) throw new Error('Duplicate connection type');
      targets.set(target, connector!);
    }
  }

  return {
    /** Returns catalog metadata without exposing implementation functions. */
    list: () => [...apps.values()].map((a) => structuredClone(a.manifest)),
    /** Returns a trusted app contribution, or undefined if its package is absent. */
    get: (id: string) => apps.get(id),
    /** Resolves the app contribution that owns a connection target. */
    provider: (kind: string) => targets.get(kind),
    /** Lists connector contributions for capability runtime composition. */
    providers: (): ConnectionProvider[] =>
      [...apps.values()].flatMap((a) => {
        const connector = a.connector;
        if (!connector) return [];
        if (!options.beforeWrite) return [connector];

        return [
          {
            ...connector,
            async build(context, id, capability, runtime) {
              if (!capability.endsWith('.read'))
                await options.beforeWrite!(context, connector.appId);

              return connector.build(context, id, capability, runtime);
            },
          },
        ];
      }),
    /**
     * Lists apps that contribute decisions to the Needs you queue. `visible` decides, per
     * decision kind, whether the reader may see and respond; the host applies it so apps keep
     * no access logic of their own.
     */
    decisionSources: (
      access: (
        context: TenantContext,
        appId: string,
        permission: string,
      ) => Promise<boolean>,
      installed: (context: TenantContext, appId: string) => Promise<boolean>,
    ) =>
      [...apps.values()].flatMap((a) =>
        a.decisions
          ? [
              {
                appId: a.manifest.id,
                name: a.manifest.name,
                decisions: async (context: TenantContext) => {
                  if (!(await installed(context, a.manifest.id))) return [];
                  const items = await a.decisions!(context);
                  const visible = [];
                  for (const item of items) {
                    const rule = a.manifest.decisionAccess?.[item.kind];
                    if (
                      !rule ||
                      !(await access(context, a.manifest.id, rule.view))
                    )
                      continue;
                    visible.push(
                      (await access(context, a.manifest.id, rule.respond))
                        ? item
                        : { ...item, response: 'view_only' as const },
                    );
                  }

                  return visible;
                },
              },
            ]
          : [],
      ),
    /**
     * Registers app-owned routes after host identity guards are attached. Tenant routes must
     * declare `config.access`; the host checks installation and that permission before the
     * handler runs. Routes without a declaration fail registration.
     */
    registerHttp(
      server: FastifyInstance,
      identity: IdentityService | undefined,
      authorize: AppAuthorizer,
    ) {
      for (const app of apps.values()) {
        if (!app.registerHttp) continue;
        void server.register(async (scope) => {
          scope.addHook('onRoute', (route) => {
            if (
              route.config?.authentication === 'app' ||
              !route.url.startsWith('/v1/organizations/:organizationId')
            )
              return;
            if (!route.config?.access)
              throw new Error(
                `App ${app.manifest.id} route ${route.method} ${route.url} must declare config.access`,
              );
          });
          scope.addHook('preHandler', async (request) => {
            const access = request.routeOptions.config.access as
              RouteAccess | undefined;
            if (!request.tenantContext || !access) return;
            if ('access' in access) {
              await authorize(request.tenantContext, { app: app.manifest.id });

              return;
            }
            const permissions =
              typeof access.permission === 'string'
                ? [access.permission]
                : access.permission;
            let denied: unknown;
            for (const permission of permissions)
              try {
                await authorize(request.tenantContext, {
                  app: app.manifest.id,
                  permission,
                });

                return;
              } catch (error) {
                denied = error;
              }
            throw denied;
          });
          app.registerHttp!(scope, identity);
        });
      }
    },
    /** Checks app deployment resources; an empty registry is ready. */
    async ready() {
      return (
        await Promise.all([...apps.values()].map((a) => a.ready?.() ?? true))
      ).every(Boolean);
    },
  };
}

export type AppRegistry = ReturnType<typeof createAppRegistry>;
