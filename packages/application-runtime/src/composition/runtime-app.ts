import { createAppHost } from '@luma/app-catalog';
import type {
  ConnectionsConfig,
  ModelGatewayConfig,
  WorkflowConfig,
} from '@luma/config';
import type { ConnectionManagement } from '@luma/connections';
import {
  createInstallationRepository,
  createInstalledPurchaseOrderRuntime,
} from '@luma/connections/composition';
import type { IdentityService } from '@luma/identity';
import { createIdentity } from '@luma/identity/composition';
import { registerIdentityHttp } from '@luma/identity/http';
import type { Observability } from '@luma/platform';
import {
  createModelGateway,
  createTenantDatabase,
} from '@luma/platform/composition';
import {
  createDeskWorkflowReader,
  createProcessClient,
} from '@luma/workflow-temporal';
import type { FastifyServerOptions } from 'fastify';
import { Pool } from 'pg';

import { createMetricListener } from '../infrastructure/metric-listener.js';
import { createApplicationServices } from './application.js';
import {
  assistantAvailability,
  authoringAvailability,
  supplierExtractionAvailability,
} from './authoring.js';
import { createCommerceSyncService } from './commerce-sync.js';
import { buildApp } from './http-app.js';
import { createReadinessCheck } from './readiness.js';
import { createResourceScope } from './resources.js';

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
  if (modelSettings && !observability)
    throw new Error('Model gateway requires observability');
  const modelGateway =
    modelSettings && observability
      ? createModelGateway(modelSettings, observability)
      : undefined;
  const resources = createResourceScope();
  try {
    const identity = createIdentity(settings);
    resources.add(identity.close);
    const casePool = new Pool({
      connectionString: settings.databaseUrl,
      max: 5,
      statement_timeout: 5000,
    });
    resources.add(() => casePool.end());
    const configured =
      typeof connections === 'function'
        ? connections(identity.service)
        : undefined;
    const installedConnections =
      configured && 'registry' in configured
        ? configured
        : createAppHost(createTenantDatabase(casePool), {
            ...(connections && typeof connections !== 'function'
              ? connections
              : {}),
            refreshContext: identity.service.refreshContext,
          });
    const connectionService =
      configured && !('registry' in configured)
        ? configured
        : connections
          ? installedConnections.connections
          : undefined;

    // Sync status only needs public connection summaries, so it stays available without a
    // credential keyring.
    const installations = createInstallationRepository(
      createTenantDatabase(casePool),
    );
    const sync = createCommerceSyncService(
      createTenantDatabase(casePool),
      identity.service,
      connectionService ?? {
        list: (context) => installations.list(context.tenantId),
      },
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
    const application = createApplicationServices({
      database: createTenantDatabase(casePool),
      identity: identity.service,
      execution: processClient
        ? { kind: 'enabled', effects: { resolve: async () => null } }
        : { kind: 'disabled' },
      ...(processClient ? { replenishmentTransport: processClient } : {}),
      desk: workflowReader ? { workflow: workflowReader.get } : {},
      ...(installedConnections
        ? { decisionSources: installedConnections.registry.decisionSources() }
        : {}),
      ...(modelGateway ? { modelGateway } : {}),
      authoring: authoringAvailability(modelSettings, !!modelGateway),
      supplierExtraction: supplierExtractionAvailability(
        modelSettings,
        !!modelGateway,
      ),
      assistant: assistantAvailability(modelSettings, !!modelGateway),
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
          }
        : {}),
    });
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
            appRegistry: installedConnections.registry,
            providerCatalog: installedConnections.providerCatalog,
          }
        : {}),
      identity: identity.service,
      settings: identity.settings,
      trustedOrigins: settings.trustedOrigins,
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
    const deliveryTimer = setInterval(() => {
      void identity.mailDelivery
        .drain()
        .catch(() => app.log.error('Email delivery pass failed'));
    }, 5000);
    deliveryTimer.unref();
    resources.add(async () => {
      clearInterval(deliveryTimer);
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
