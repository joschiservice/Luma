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
  createInstalledMessageRuntime,
  createInstalledPurchaseOrderRuntime,
  createInstalledReturnRuntime,
  createInstalledRuntime,
} from '@luma/connections/composition';
import type { IdentityService, TenantContext } from '@luma/identity';
import {
  createIdentity,
  createMorningBriefReader,
} from '@luma/identity/composition';
import { registerIdentityHttp, requestIsReadOnly } from '@luma/identity/http';
import type { Observability } from '@luma/platform';
import {
  createModelGateway,
  createTenantDatabase,
  createValkeyStore,
} from '@luma/platform/composition';
import {
  createShipmentDispatchOptionsReader,
  createShipmentDispatchReader,
} from '@luma/read-models/composition';
import {
  createDeskWorkflowReader,
  createProcessClient,
} from '@luma/workflow-temporal';
import type { FastifyServerOptions } from 'fastify';
import { Pool } from 'pg';

import { assertCellRegion } from '../cell-region.js';
import { createMetricListener } from '../infrastructure/metric-listener.js';
import {
  type ApplicationServices,
  createApplicationServices,
  createOrderLineReader,
} from './application.js';
import {
  assistantAvailability,
  authoringAvailability,
  documentExtractionAvailability,
  supplierExtractionAvailability,
} from './authoring.js';
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
 * Creates the configured API and its database-backed services. Closing the app releases its
 * database pools and workflow reader.
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
  workflowSettings?: WorkflowConfig,
) {
  if (workflowSettings)
    workflowSettings = {
      ...workflowSettings,
      temporal: createRegionalTemporalSettings(workflowSettings.temporal),
    };
  if (modelSettings && !observability)
    throw new Error('Model gateway requires observability');
  const modelGateway =
    modelSettings && observability
      ? createModelGateway(modelSettings, observability)
      : undefined;
  const resources = createResourceScope();
  try {
    // Auth rate limits share counters with every API instance when a store is configured.
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
    const casePool = new Pool({
      connectionString: settings.databaseUrl,
      max: 5,
      statement_timeout: 5000,
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

    const workflowReader = workflowSettings
      ? createDeskWorkflowReader(workflowSettings.temporal, identity.service)
      : undefined;
    if (workflowReader) resources.add(workflowReader.close);
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
    const mailboxRuntime =
      connections && 'registry' in installedConnections
        ? createInstalledMessageRuntime({
            installations: installedConnections.connections,
            providers: installedConnections.registry.providers(),
            record: async () => undefined,
            recordObservations: async () => undefined,
          })
        : undefined;
    const application = createApplicationServices({
      database: tenantDatabase(),
      identity: identity.service,
      providerCatalog: installedConnections.providerCatalog,
      ...('connectionEnvironment' in installedConnections
        ? { connectionEnvironment: installedConnections.connectionEnvironment }
        : {}),
      execution: processClient
        ? { kind: 'enabled', effects: { resolve: async () => null } }
        : { kind: 'disabled' },
      ...(processClient ? { replenishmentTransport: processClient } : {}),
      desk: workflowReader ? { workflow: workflowReader.get } : {},
      ...(installedConnections
        ? {
            decisionSources: installedConnections.decisionSources(),
            workflowSources: installedConnections.registry.workflowSources(),
            actionPermission: installedConnections.registry.actionPermission,
            ...(stockRefresh ? { refreshStock } : {}),
            nativeStockReader: createInstalledRuntime({
              installations: installedConnections.connections,
              providers: installedConnections.registry.providers(),
              record: async () => undefined,
              recordObservations: async () => undefined,
            }),
          }
        : {}),
      ...(modelGateway ? { modelGateway } : {}),
      authoring: authoringAvailability(modelSettings, !!modelGateway),
      supplierExtraction: supplierExtractionAvailability(
        modelSettings,
        !!modelGateway,
      ),
      assistant: assistantAvailability(modelSettings, !!modelGateway),
      documentExtraction: documentExtractionAvailability(
        modelSettings,
        !!modelGateway,
      ),
      ...(observability ? { observability } : {}),
      ...(connections && 'registry' in installedConnections
        ? {
            purchasing: {
              runtime: createInstalledPurchaseOrderRuntime({
                installations: installedConnections.connections,
                providers: installedConnections.registry.providers(),
                // Procurement stores the purchase-order observations it uses as evidence.
                record: async () => undefined,
                recordObservations: async () => undefined,
              }),
              installations: installedConnections.connections,
            },
            returns: {
              runtime: createInstalledReturnRuntime({
                installations: installedConnections.connections,
                providers: installedConnections.registry.providers(),
                // Return cases keep the creation evidence they use.
                record: async () => undefined,
                recordObservations: async () => undefined,
              }),
              installations: installedConnections.connections,
            },
          }
        : {}),
      // Mailboxes are listed from installed connections; threads are reread on demand.
      ...(connectionService
        ? {
            messaging: {
              installations: connectionService,
              // Replies are sent through the same runtime when execution is enabled.
              ...(mailboxRuntime
                ? { reader: mailboxRuntime, sender: mailboxRuntime }
                : {}),
            },
          }
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
    casePool.on('error', () =>
      app.log.error('Case database connection failed'),
    );
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
    let briefPass: Promise<void> | undefined;
    const briefTimer = setInterval(() => {
      briefPass ??= scheduleMorningBriefs()
        .catch(() => app.log.error('Morning brief schedule pass failed'))
        .finally(() => {
          briefPass = undefined;
        });
    }, 60000);
    briefTimer.unref();
    resources.add(async () => {
      clearInterval(briefTimer);
      await briefPass;
    });
    const deliveryTimer = setInterval(() => {
      void identity.mailDelivery
        .drain()
        .catch(() => app.log.error('Email delivery pass failed'));
    }, 5000);
    deliveryTimer.unref();
    // Retention runs a minute after start, so frequent restarts don't skip it, then hourly.
    const purge = () =>
      void identity
        .purgeSecurityEvents()
        .catch(() => app.log.error('Security event retention pass failed'));
    const retentionStart = setTimeout(purge, 60_000);
    const retentionTimer = setInterval(purge, 60 * 60_000);
    retentionStart.unref();
    retentionTimer.unref();
    // Support views nobody uses again still need their end recorded and owners told.
    const supportViewTimer = setInterval(() => {
      void identity.service
        .sweepSupportViews(`support-view-sweep:${randomUUID()}`)
        .catch(() => app.log.error('Support view sweep failed'));
    }, 60_000);
    supportViewTimer.unref();
    // Deletions become due after their restore window, or at once for an erasure request.
    const erasureTimer = setInterval(() => {
      void identity
        .eraseDueAccounts()
        .catch(() => app.log.error('Account erasure pass failed'));
    }, 60_000);
    erasureTimer.unref();
    resources.add(async () => {
      clearInterval(deliveryTimer);
      clearTimeout(retentionStart);
      clearInterval(retentionTimer);
      clearInterval(supportViewTimer);
      clearInterval(erasureTimer);
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
