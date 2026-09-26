import type {
  ConnectionsConfig,
  ModelGatewayConfig,
  WorkflowConfig,
} from '@luma/config';
import type { ConnectionManagement } from '@luma/connections';
import {
  createInstallationVerifier,
  createInstalledConnections,
} from '@luma/connections/composition';
import type { IdentityService } from '@luma/identity';
import { createIdentity } from '@luma/identity/composition';
import { registerIdentityHttp } from '@luma/identity/http';
import type { Observability } from '@luma/platform';
import {
  createModelGateway,
  createTenantDatabase,
} from '@luma/platform/composition';
import { createDeskWorkflowReader } from '@luma/workflow-temporal';
import type { FastifyServerOptions } from 'fastify';
import { Pool } from 'pg';

import { createApplicationServices } from './application.js';
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
    ConnectionsConfig | ((identity: IdentityService) => ConnectionManagement),
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
    const connectionPool =
      connections && typeof connections !== 'function'
        ? new Pool({
            connectionString: settings.databaseUrl,
            max: 10,
            connectionTimeoutMillis: 5000,
            statement_timeout: 5000,
            idle_in_transaction_session_timeout: 10000,
          })
        : undefined;
    if (connectionPool) resources.add(() => connectionPool.end());
    const installedConnections =
      connections && typeof connections !== 'function' && connectionPool
        ? createInstalledConnections(createTenantDatabase(connectionPool), {
            ...connections,
            refreshContext: identity.service.refreshContext,
            verify: createInstallationVerifier({
              jtlEndpoints: connections.jtlEndpoints,
            }),
          })
        : undefined;
    const connectionService =
      typeof connections === 'function'
        ? connections(identity.service)
        : installedConnections;
    const casePool = new Pool({
      connectionString: settings.databaseUrl,
      max: 5,
      statement_timeout: 5000,
    });
    resources.add(() => casePool.end());
    const workflowReader = workflowSettings
      ? createDeskWorkflowReader(workflowSettings.temporal, identity.service)
      : undefined;
    if (workflowReader) resources.add(workflowReader.close);
    const application = createApplicationServices({
      database: createTenantDatabase(casePool),
      identity: identity.service,
      execution: { kind: 'disabled' },
      desk: workflowReader ? { workflow: workflowReader.get } : {},
    });
    const app = buildApp(options, {
      ...application.http,
      ...(observability ? { observability } : {}),
      ...(modelGateway ? { modelGateway } : {}),
      ...(connectionService ? { connections: connectionService } : {}),
      ...(installedConnections?.shopify
        ? { shopify: installedConnections.shopify }
        : {}),
      identity: identity.service,
      settings: identity.settings,
      trustedOrigins: settings.trustedOrigins,
      checkReadiness: createReadinessCheck(
        identity.checkReadiness,
        connectionPool,
        !!installedConnections?.shopify,
      ),
    });
    if (connectionPool) {
      connectionPool.on('error', () =>
        app.log.error('Connection database connection failed'),
      );
    }
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
