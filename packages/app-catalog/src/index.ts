import { randomUUID } from 'node:crypto';

import type { AppRegistry, AppService } from '@luma/app-host';
import {
  type AppFactory,
  type AppFactoryContext,
  createAppRegistry,
  createAppService,
} from '@luma/app-host';
import type {
  ConnectionProvider,
  InstallationDependencies,
  InstallationService,
  InstallationTarget,
  ProviderCatalog,
} from '@luma/connections';
import { ConnectorError } from '@luma/connections';
import {
  createInstallationRepository,
  createInstallationService as connections,
  createProviderCatalog,
  createSecretCipher,
} from '@luma/connections/composition';
import { IdentityError } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import { factories } from './generated.js';

/** Composes the available first-party apps. An empty factory list boots a host with no apps. */
export function createAppHost(
  database: TenantDatabase,
  options: {
    activeKeyId?: string;
    keys?: ReadonlyMap<string, Uint8Array>;
    refreshContext: InstallationDependencies['refreshContext'];
    env?: Readonly<Record<string, string | undefined>>;
    factories?: readonly AppFactory[];
    simulation?: AppFactoryContext['simulation'];
  },
): {
  registry: AppRegistry;
  apps: AppService;
  connections: InstallationService;
  providerCatalog: ProviderCatalog;
  /** Lists installed apps' decisions, filtered by each decision kind's declared permissions. */
  decisionSources(): ReturnType<AppRegistry['decisionSources']>;
} {
  const unavailable = () => {
    throw new IdentityError(
      503,
      'SERVICE_UNAVAILABLE',
      'Connection credential storage is not configured',
    );
  };
  const cipher =
    options.activeKeyId && options.keys
      ? createSecretCipher(options.activeKeyId, options.keys)
      : { seal: unavailable, open: unavailable };
  const registry = createAppRegistry(
    (options.factories ?? factories).map((factory) =>
      factory({
        database,
        cipher,
        ...(options.simulation ? { simulation: options.simulation } : {}),
        refreshContext: options.refreshContext,
        env: options.env ?? process.env,
        requireInstalled: (context, appId) =>
          apps.requireInstalled(context, appId),
        requirePermission: (context, operation) =>
          apps.requirePermission(context, operation),
        hasPermission: (context, operation) =>
          apps.hasPermission(context, operation),
      }),
    ),
    {
      beforeWrite: (context, appId) =>
        apps.requireGranted(context, appId, ['actions.execute']),
    },
  );
  const apps = createAppService(database, registry, options.refreshContext);
  const provider = (target: InstallationTarget): ConnectionProvider => {
    const contribution = registry.provider(target.kind);
    if (!contribution)
      throw new ConnectorError({
        code: 'unavailable',
        effect: 'none',
        retry: 'never',
      });

    return contribution;
  };
  const service = connections({
    ...options,
    cipher,
    repository: createInstallationRepository(database),
    id: randomUUID,
    now: () => new Date(),
    provider: async (context, target) => {
      const p = provider(target);
      const appInstallationVersion = await apps.requireInstalled(
        context,
        p.appId,
      );

      return {
        appId: p.appId,
        provider: p.provider,
        appInstallationVersion,
        management: p.management ?? ['check', 'rotate'],
      };
    },
    validate: (input) => {
      const p = provider(input.target);
      p.manage?.('install');

      return p.validate(input);
    },
    validateCredentials: (target, input) => {
      const p = provider(target);
      p.manage?.('rotate');

      return p.credentials(target, input);
    },
    beforeCheck: (target) => provider(target).manage?.('check'),
    verify: (connection, credentials) => {
      const p = provider(connection.target);

      return p.verify(connection, credentials);
    },
    refreshCredential: (context, id, target) =>
      provider(target).refreshCredential?.(context, id) ?? Promise.resolve(),
  });

  return {
    registry,
    apps,
    decisionSources: () =>
      registry.decisionSources(
        (context, app, permission) =>
          apps.hasPermission(context, { app, permission }),
        (context, app) => apps.installed(context, app),
      ),
    connections: {
      ...service,
      async list(context) {
        return (await service.list(context)).map((connection) => {
          const contribution = registry.provider(connection.target.kind);

          return {
            ...connection,
            management: contribution
              ? (contribution.management ?? ['check', 'rotate'])
              : [],
          };
        });
      },
    },
    providerCatalog: createProviderCatalog(
      registry
        .list()
        .filter((a) => a.category !== 'utility')
        .map((a) => ({
          id: a.id,
          name: a.name,
          category: a.category as 'storefront' | 'erp',
        })),
    ),
  };
}
