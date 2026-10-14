import { randomUUID } from 'node:crypto';

import type { AppRegistry, AppService } from '@luma/app-host';
import {
  type AppFactory,
  type AppFactoryContext,
  createAppRegistry,
  createAppService,
} from '@luma/app-host';
import { readRequestAdmissionConfig } from '@luma/config';
import type {
  ConnectionProvider,
  InstallationDependencies,
  InstallationService,
  InstallationTarget,
  ProviderCatalog,
  SourceEnvironmentProof,
  SourceEnvironments,
} from '@luma/connections';
import { ConnectorError } from '@luma/connections';
import {
  createInstallationRepository,
  createInstallationService as connections,
  createProviderCatalog,
  createSecretCipher,
  createSourceAuthority,
  createSourceEnvironmentService,
} from '@luma/connections/composition';
import { IdentityError, type TenantContext } from '@luma/identity';
import type { AtomicStore, TenantDatabase } from '@luma/platform';
import { createValkeyStore } from '@luma/platform/composition';

import { factories } from './generated.js';

/** Composes the available first-party apps. An empty factory list boots a host with no apps. */
export function createAppHost(
  database: TenantDatabase,
  options: {
    activeKeyId?: string;
    keys?: ReadonlyMap<string, Uint8Array>;
    refreshContext: InstallationDependencies['refreshContext'];
    env?: Readonly<Record<string, string | undefined>>;
    requestBudgetStore?: AtomicStore;
    factories?: readonly AppFactory[];
    featureEnabled?: AppFactoryContext['featureEnabled'];
    simulation?: AppFactoryContext['simulation'];
    refreshStock?: AppFactoryContext['refreshStock'];
    sourceOrderLines?: AppFactoryContext['sourceOrderLines'];
    shipmentDispatchEvidence?: AppFactoryContext['shipmentDispatchEvidence'];
    shipmentDispatchOptions?: AppFactoryContext['shipmentDispatchOptions'];
    refreshOrder?: AppFactoryContext['refreshOrder'];
    orderChangePlans?: AppFactoryContext['orderChangePlans'];
    /**
     * Whether a workspace's Luma-owned order records are released. Without it, source authority
     * leaves Luma ERP out, as for workspaces without the release.
     */
    internalOrdersEnabled?: (tenantId: string) => Promise<boolean>;
  },
): {
  registry: AppRegistry;
  /** Releases this host's provider admission connection. Injected stores belong to their caller. */
  close(): Promise<void>;
  apps: AppService;
  connections: InstallationService;
  providerCatalog: ProviderCatalog;
  sourceEnvironments: SourceEnvironments;
  /** Trusted reviewed declaration or positive manifest proof; missing and changed bindings stay unknown. */
  connectionEnvironment(
    context: TenantContext,
    id: string,
  ): Promise<SourceEnvironmentProof>;
  /** Lists installed apps' decisions, filtered by each decision kind's declared permissions. */
  decisionSources(): ReturnType<AppRegistry['decisionSources']>;
} {
  const admissionConfig = readRequestAdmissionConfig({
    ...process.env,
    ...options.env,
  });
  const ownedStore = options.requestBudgetStore
    ? undefined
    : admissionConfig
      ? createValkeyStore(admissionConfig.url, admissionConfig.cluster)
      : undefined;
  const requestBudgetStore = options.requestBudgetStore ??
    ownedStore ?? {
      run: async () => {
        throw new Error('Shopify request admission is not configured');
      },
      ready: async () => false,
      close: async () => undefined,
    };
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
        requestBudgetStore,
        ...(options.featureEnabled
          ? { featureEnabled: options.featureEnabled }
          : {}),
        sourceAuthority: { read: (context) => sourceAuthority.read(context) },
        cipher,
        ...(options.simulation ? { simulation: options.simulation } : {}),
        ...(options.refreshStock ? { refreshStock: options.refreshStock } : {}),
        ...(options.sourceOrderLines
          ? { sourceOrderLines: options.sourceOrderLines }
          : {}),
        ...(options.shipmentDispatchEvidence
          ? { shipmentDispatchEvidence: options.shipmentDispatchEvidence }
          : {}),
        ...(options.shipmentDispatchOptions
          ? { shipmentDispatchOptions: options.shipmentDispatchOptions }
          : {}),
        ...(options.refreshOrder ? { refreshOrder: options.refreshOrder } : {}),
        ...(options.orderChangePlans
          ? { orderChangePlans: options.orderChangePlans }
          : {}),
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

  const sourceAuthority = createSourceAuthority(
    database,
    (provider) => {
      // Luma-owned order records are Luma's built-in ERP source, not an installed app.
      if (provider === 'luma-erp') return 'erp';
      const category = registry
        .list()
        .find((app) => app.id === provider)?.category;

      return category === 'erp' || category === 'storefront' ? category : null;
    },
    options.refreshContext,
    options.internalOrdersEnabled,
  );

  const sourceEnvironments = createSourceEnvironmentService(database, {
    refreshContext: options.refreshContext,
    connections: service,
    enabled: (tenantId) =>
      options.featureEnabled?.(tenantId, 'scoped-autonomy') ??
      Promise.resolve(false),
    synthetic: (connection) => options.simulation?.(connection) !== undefined,
    async installed(context, connection) {
      if (!connection.appId) return false;
      try {
        return (
          (await apps.requireInstalled(context, connection.appId)) ===
          connection.appInstallationVersion
        );
      } catch (error) {
        if (
          error instanceof IdentityError &&
          [403, 404, 409].includes(error.statusCode)
        )
          return false;
        throw error;
      }
    },
    async readEvidence(context, connection, signal) {
      const adapter = await provider(connection.target).build(
        context,
        connection.id,
        'purchase-orders.read',
        {
          installations: service,
          recordObservations: async () => undefined,
          readBounds: {
            signal,
            maxRequests: 4,
            maxResponseBytes: 1_048_576,
            maxTotalBytes: 2_097_152,
          },
          ...(options.simulation ? { simulation: options.simulation } : {}),
        },
      );
      const handler = adapter.capabilities['purchase-orders.read'];
      if (!handler)
        throw new IdentityError(
          409,
          'CONFLICT',
          'Purchase-order evidence is unavailable',
        );
      const output = handler.parseOutput(
        await handler.run(
          {
            tenant: context,
            connectionId: connection.id,
            provider: adapter.provider,
          },
          handler.parseInput({ limit: 1 }),
        ),
      );
      if (
        output.completeness !== 'complete' ||
        output.items.some(
          ({ source }) =>
            source.tenantId !== context.tenantId ||
            source.connectionId !== connection.id ||
            source.provider !== adapter.provider,
        )
      )
        throw new IdentityError(
          409,
          'CONFLICT',
          'Source evidence is incomplete',
        );

      return output.items.map((o) => ({
        id: o.id,
        provider: o.source.provider,
        resource: o.source.resource,
        sourceRevision: o.sourceRevision,
        observedAt: o.observedAt,
      }));
    },
  });

  return {
    close: async () => {
      await ownedStore?.close();
    },
    sourceEnvironments,
    connectionEnvironment: sourceEnvironments.classify,
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
        .filter(
          (a): a is typeof a & { category: 'storefront' | 'erp' } =>
            a.category === 'storefront' || a.category === 'erp',
        )
        .map((a) => ({
          id: a.id,
          name: a.name,
          category: a.category,
        })),
    ),
  };
}
