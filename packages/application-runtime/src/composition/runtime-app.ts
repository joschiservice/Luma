import { randomUUID } from 'node:crypto';

import { createAppHost } from '@luma/app-catalog';
import type {
  ConnectionsConfig,
  ModelGatewayConfig,
  WorkflowConfig,
} from '@luma/config';
import type { ConnectionManagement } from '@luma/connections';
import {
  createInstallationRepository,
  createInstalledRuntime,
} from '@luma/connections/composition';
import type { IdentityService, TenantContext } from '@luma/identity';
import {
  createIdentity,
  createMorningBriefReader,
} from '@luma/identity/composition';
import { registerIdentityHttp, requestIsReadOnly } from '@luma/identity/http';
import { createFailureLog, type Observability } from '@luma/platform';
import {
  createDatabasePool,
  createModelGateway,
  createModelRequestLimit,
  createTenantDatabase,
  createValkeyStore,
} from '@luma/platform/composition';
import {
  createShipmentDispatchOptionsReader,
  createShipmentDispatchReader,
} from '@luma/read-models/composition';
import {
  createDeskWorkflowClient,
  createProcessClient,
} from '@luma/workflow-temporal';
import type { FastifyServerOptions } from 'fastify';

import { assertCellRegion } from '../cell-region.js';
import { createMetricListener } from '../infrastructure/metric-listener.js';
import {
  type ApplicationServices,
  createApplicationServices,
  createOrderLineReader,
} from './application.js';
import { applicationOptionsFor } from './application-options.js';
import { createCommerceSyncService } from './commerce-sync.js';
import {
  createOrderRefreshService,
  createStockRefreshService,
} from './detection-worker.js';
import { createTenantFeatureRelease } from './feature-release.js';
import { buildApp } from './http-app.js';
import { createReadinessCheck } from './readiness.js';
import { createResourceScope } from './resources.js';
import { createSalesReadSource, createSalesTenantRelease } from './sales.js';
import { createRegionalTemporalSettings } from './temporal-settings.js';

/**
 * Creates the configured API and its database-backed services. With `workflowSettings`, the API
 * starts workflows through Temporal; it never needs the worker's database login. Closing the app
 * releases its database pools and workflow reader.
 */
export async function buildRuntimeApp(
  settings: Parameters<typeof createIdentity>[0],
  options: FastifyServerOptions = {},
  observability?: Observability,
  modelSettings?: ModelGatewayConfig,
  connections?:
    | ConnectionsConfig
    | ((
        identity: IdentityService,
      ) => ConnectionManagement | ReturnType<typeof createAppHost>),
  workflowSettings?: Pick<WorkflowConfig, 'temporal'>,
) {
  if (workflowSettings)
    workflowSettings = {
      ...workflowSettings,
      temporal: createRegionalTemporalSettings(workflowSettings.temporal),
    };
  if (modelSettings && !observability)
    throw new Error('Model gateway requires observability');
  const resources = createResourceScope();
  const log = createFailureLog(observability);
  try {
    // Auth and model limits share counters with every API instance when a store is configured.
    const rateLimitStore =
      settings.rateLimitStore ??
      (settings.rateLimit?.store
        ? createValkeyStore(
            settings.rateLimit.store.url,
            settings.rateLimit.store.cluster,
          )
        : undefined);
    if (rateLimitStore && !settings.rateLimitStore)
      resources.add(() => rateLimitStore.close());
    const modelGateway =
      modelSettings && observability
        ? createModelGateway(modelSettings, observability, {
            ...(rateLimitStore ? { budgetStore: rateLimitStore } : {}),
          })
        : undefined;
    const identity = createIdentity({
      ...settings,
      ...(rateLimitStore ? { rateLimitStore } : {}),
      readOnly: requestIsReadOnly,
      morningBriefEnabled: (tenantId) =>
        createTenantFeatureRelease(observability)(
          tenantId,
          'operational-morning-brief',
        ),
    });
    resources.add(identity.close);
    const casePool = createDatabasePool({
      connectionString: settings.databaseUrl,
      max: 5,
      workload: 'request',
      onError: (error) => log('Case database connection failed', error),
    });
    resources.add(() => casePool.end());
    await assertCellRegion(casePool, settings.region ?? 'AU');
    // Support views restrict their requests to reads; these transactions then refuse writes.
    const tenantDatabase = () =>
      createTenantDatabase(casePool, { readOnly: requestIsReadOnly });
    const configured =
      typeof connections === 'function'
        ? connections(identity.service)
        : undefined;
    // Owners reread stale stock and order sources right before they act; the rereads need the
    // host's providers. Plans come from the Orders workspace composed below.
    let stockRefresh: ReturnType<typeof createStockRefreshService> | undefined;
    let orderRefresh: ReturnType<typeof createOrderRefreshService> | undefined;
    const composed: { orders?: ApplicationServices['http']['orders'] } = {};
    const refreshStock = async (
      context: TenantContext,
      positionId: string,
      maxAgeMs?: number,
      options?: Parameters<
        ReturnType<typeof createStockRefreshService>['refresh']
      >[3],
    ) => stockRefresh?.refresh(context, positionId, maxAgeMs, options);
    const installedConnections =
      configured && 'registry' in configured
        ? configured
        : createAppHost(tenantDatabase(), {
            ...(connections && typeof connections !== 'function'
              ? connections
              : {}),
            refreshContext: identity.service.refreshContext,
            refreshStock,
            sourceOrderLines: createOrderLineReader(tenantDatabase()),
            shipmentDispatchOptions:
              createShipmentDispatchOptionsReader(tenantDatabase()),
            shipmentDispatchEvidence: createShipmentDispatchReader(
              tenantDatabase(),
              async (context, orderId, maxAgeMs) => {
                await orderRefresh?.refresh(context, orderId, maxAgeMs);
              },
            ),
            refreshOrder: async (context, orderId, maxAgeMs) => {
              await orderRefresh?.refresh(context, orderId, maxAgeMs);
            },
            internalOrdersEnabled: createSalesTenantRelease(observability),
            featureEnabled: createTenantFeatureRelease(observability),
            orderChangePlans: async (context, orderId, request) => {
              if (!composed.orders)
                throw new Error('Order plans are not composed yet');

              return composed.orders.changePlan(context, orderId, request);
            },
          });
    resources.add(installedConnections.close);
    if (connections && typeof connections !== 'function') {
      const capabilities = createInstalledRuntime({
        internalSource: createSalesReadSource(tenantDatabase(), observability),
        installations: installedConnections.connections,
        providers: installedConnections.registry.providers(),
        // Owners record the reads they use as evidence; telemetry has no sink here.
        record: async () => undefined,
        recordObservations: async () => undefined,
      });
      stockRefresh = createStockRefreshService({
        database: tenantDatabase(),
        capabilities,
      });
      resources.add(stockRefresh.close);
      orderRefresh = createOrderRefreshService({
        database: tenantDatabase(),
        capabilities,
      });
      resources.add(orderRefresh.close);
    }
    const connectionService =
      configured && !('registry' in configured)
        ? configured
        : connections
          ? installedConnections.connections
          : undefined;

    // Sync status only needs public connection summaries, so it stays available without a
    // credential keyring.
    const installations = createInstallationRepository(tenantDatabase());
    const sync = createCommerceSyncService(
      tenantDatabase(),
      identity.service,
      connectionService ?? {
        list: (context) => installations.list(context.tenantId),
      },
      observability,
    );

    const deskWorkflow = workflowSettings
      ? createDeskWorkflowClient(workflowSettings.temporal, identity.service)
      : undefined;
    if (deskWorkflow) resources.add(deskWorkflow.close);
    const processClient = workflowSettings
      ? await createProcessClient(
          {
            ...workflowSettings.temporal,
            taskQueue: `${workflowSettings.temporal.taskQueue}-procurement`,
          },
          identity.service,
        )
      : undefined;
    if (processClient) resources.add(processClient.close);
    const { messaging: mailboxes, ...shared } = applicationOptionsFor(
      installedConnections,
      {
        // Without connection settings, purchase orders, returns and mailboxes stay local.
        providerRuntimes: !!connections,
        ...(modelGateway && modelSettings
          ? {
              model: {
                gateway: modelGateway,
                settings: modelSettings,
                requestLimit: createModelRequestLimit(rateLimitStore),
              },
            }
          : {}),
        ...(observability ? { observability } : {}),
      },
    );
    const application = createApplicationServices({
      database: tenantDatabase(),
      identity: identity.service,
      ...shared,
      execution: processClient
        ? { kind: 'enabled', effects: { resolve: async () => null } }
        : { kind: 'disabled' },
      ...(processClient ? { replenishmentTransport: processClient } : {}),
      desk: deskWorkflow
        ? {
            workflow: deskWorkflow.get,
            notifyApproval: deskWorkflow.notifyApproval,
          }
        : {},
      ...(stockRefresh ? { refreshStock } : {}),
      // Mailboxes are listed from the configured connection service, which may be injected.
      ...(connectionService
        ? { messaging: { ...mailboxes, installations: connectionService } }
        : {}),
    });
    composed.orders = application.http.orders;
    const metricEvents = createMetricListener(settings.databaseUrl);
    resources.add(metricEvents.close);
    const app = buildApp(options, {
      metricEvents,
      ...application.http,
      ...(observability ? { observability } : {}),
      ...(modelGateway ? { modelGateway } : {}),
      ...(connectionService ? { connections: connectionService } : {}),
      sync,
      ...(installedConnections
        ? {
            apps: installedConnections.apps,
            ...('sourceEnvironments' in installedConnections
              ? { sourceEnvironments: installedConnections.sourceEnvironments }
              : {}),
            appRegistry: installedConnections.registry,
            providerCatalog: installedConnections.providerCatalog,
          }
        : {}),
      identity: identity.service,
      settings: identity.settings,
      apiApps: identity.apiApps,
      roles: identity.roles((tenantId) =>
        installedConnections.apps.permissions(tenantId),
      ),
      trustedOrigins: settings.trustedOrigins,
      httpsOrigin: new URL(settings.baseURL).protocol === 'https:',
      checkReadiness: createReadinessCheck(
        identity.checkReadiness,
        connections ? casePool : undefined,
        installedConnections?.registry.ready,
      ),
    });
    registerIdentityHttp(app, identity);
    const scheduleMorningBriefs = identity.morningBriefScheduler({
      enabled: (tenantId) =>
        createTenantFeatureRelease(observability)(
          tenantId,
          'operational-morning-brief',
        ),
      read: createMorningBriefReader({
        decisions: (context) =>
          application.http.decisions.list(context, { view: 'all', limit: 5 }),
        overview: (context, asOf, start) =>
          application.http.operations(context, '24h', asOf, start),
        active: (context) =>
          application.http.cases.list(context, { view: 'active', limit: 5 }),
        origin:
          settings.mail?.origin ?? settings.mailOrigin ?? settings.baseURL,
      }),
    });
    // A tick while the same pass still runs is skipped, so passes never overlap. Close waits
    // for running passes before the pools they use are released.
    const running = new Set<Promise<void>>();
    const timers: ReturnType<typeof setTimeout>[] = [];
    const schedule = (
      message: string,
      pass: () => Promise<unknown>,
      intervalMs: number,
      firstMs = intervalMs,
    ) => {
      let current: Promise<void> | undefined;
      const tick = () => {
        if (current) return;
        const run = pass()
          .then(
            () => undefined,
            (error: unknown) => log(message, error),
          )
          .finally(() => {
            running.delete(run);
            current = undefined;
          });
        current = run;
        running.add(run);
      };
      const start = setTimeout(() => {
        tick();
        const timer = setInterval(tick, intervalMs);
        timer.unref();
        timers.push(timer);
      }, firstMs);
      start.unref();
      timers.push(start);
    };
    schedule(
      'Morning brief schedule pass failed',
      scheduleMorningBriefs,
      60_000,
    );
    schedule(
      'Email delivery pass failed',
      () => identity.mailDelivery.drain(),
      5000,
    );
    // Retention runs a minute after start, so frequent restarts don't skip it, then hourly.
    schedule(
      'Security event retention pass failed',
      () => identity.purgeSecurityEvents(),
      60 * 60_000,
      60_000,
    );
    // Support views nobody uses again still need their end recorded and owners told.
    schedule(
      'Support view sweep failed',
      () =>
        identity.service.sweepSupportViews(
          `support-view-sweep:${randomUUID()}`,
        ),
      60_000,
    );
    // Deletions become due after their restore window, or at once for an erasure request.
    schedule(
      'Account erasure pass failed',
      () => identity.eraseDueAccounts(),
      60_000,
    );
    schedule(
      'API app expiry notice pass failed',
      () => identity.queueApiAppExpiryNotices(),
      60 * 60_000,
      60_000,
    );
    resources.add(async () => {
      // Clearing a timeout with clearInterval, or the reverse, is valid in Node.
      for (const timer of timers) clearInterval(timer);
      await Promise.all(running);
      await identity.mailDelivery.drain();
    });
    app.addHook('onClose', resources.close);

    return app;
  } catch (error) {
    try {
      await resources.close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Application startup failed', {
        cause: cleanup,
      });
    }
    throw error;
  }
}
