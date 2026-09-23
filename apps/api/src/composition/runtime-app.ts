import type {
  ConnectionsConfig,
  ModelGatewayConfig,
  WorkflowConfig,
} from '@luma/config';
import type { FastifyServerOptions } from 'fastify';
import { Pool } from 'pg';

import {
  createConnectionCoverage,
  createInstallationVerifier,
  createInstalledConnections,
} from '#modules/connectors/composition';
import type { ConnectionManagement } from '#modules/connectors/index';
import { createCases } from '#modules/exceptions/composition';
import { createIdentity } from '#modules/identity/composition';
import type { IdentityService } from '#modules/identity/index';
import {
  createModelGateway,
  createTenantDatabase,
} from '#modules/platform/composition';
import type { Observability } from '#modules/platform/index';
import {
  createDeskWorkflowReader,
  createOperationsOverview,
  createResolutionLearning,
  createWorkspaceActivity,
} from '#modules/workflows/composition';

import { buildApp } from './http-app.js';
import { createPersistentPlaybookLibrary } from './playbook-library.js';
import { createDeskServices } from './services.js';

/**
 * Creates the configured API and its database-backed services. Closing the app releases its
 * database pools and workflow reader.
 */
export function buildRuntimeApp(
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
  const identity = createIdentity(settings);
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
  const cases = createCases(createTenantDatabase(casePool));
  const workflowReader = workflowSettings
    ? createDeskWorkflowReader(workflowSettings.temporal, identity.service)
    : undefined;
  const desk = createDeskServices(
    createTenantDatabase(casePool),
    identity.service,
    undefined,
    workflowReader ? { workflow: workflowReader.get } : {},
  );
  const app = buildApp(options, {
    cases,
    activity: createWorkspaceActivity(
      createTenantDatabase(casePool),
      identity.service.refreshContext,
    ),
    desk,
    playbooks: createPersistentPlaybookLibrary(
      createTenantDatabase(casePool),
      identity.service,
    ),
    learning: createResolutionLearning(
      createTenantDatabase(casePool),
      identity.service.refreshContext,
    ),
    operations: createOperationsOverview(
      cases,
      createConnectionCoverage(createTenantDatabase(casePool)),
    ),
    ...(observability ? { observability } : {}),
    ...(modelGateway ? { modelGateway } : {}),
    ...(connectionService ? { connections: connectionService } : {}),
    ...(installedConnections?.shopify
      ? { shopify: installedConnections.shopify }
      : {}),
    identity: identity.service,
    trustedOrigins: settings.trustedOrigins,
    checkReadiness: async () => {
      if (!(await identity.checkReadiness())) return false;
      if (connectionPool) {
        const result = await connectionPool.query<{ safe: boolean }>(`SELECT
          NOT r.rolsuper AND NOT r.rolbypassrls
          AND pg_has_role(current_user, 'luma_connectors', 'MEMBER')
          AND NOT EXISTS (SELECT FROM pg_class c WHERE c.oid IN ('connector_installations'::regclass, 'connector_lifecycle_events'::regclass) AND pg_has_role(current_user, c.relowner, 'MEMBER')) AS safe
          FROM pg_roles r WHERE r.rolname = current_user`);
        if (result.rows[0]?.safe !== true) return false;
        await connectionPool.query(
          'SELECT id FROM connector_installations LIMIT 0',
        );
        if (installedConnections?.shopify) {
          await connectionPool.query(
            'SELECT digest FROM shopify_oauth_states LIMIT 0',
          );
          await connectionPool.query(
            'SELECT connection_id FROM shopify_installation_bindings LIMIT 0',
          );
        }
      }

      return true;
    },
  });
  if (connectionPool) {
    connectionPool.on('error', () =>
      app.log.error('Connection database connection failed'),
    );
    app.addHook('onClose', () => connectionPool.end());
  }
  casePool.on('error', () => app.log.error('Case database connection failed'));
  app.addHook('onClose', () => casePool.end());
  if (workflowReader) app.addHook('onClose', workflowReader.close);
  identity.register(app);
  app.addHook('onClose', identity.close);

  return app;
}
