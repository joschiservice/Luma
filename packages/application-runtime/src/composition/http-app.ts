import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';

import type { ApiError } from '@luma/api-contract';
import { apiContract } from '@luma/api-contract';
import { openApiDocument } from '@luma/api-contract/openapi';
import type { AppRegistry, AppService } from '@luma/app-host';
import { appRoutes } from '@luma/app-host/http';
import type { SyncService } from '@luma/commerce-sync';
import { syncRoutes } from '@luma/commerce-sync/http';
import type { ConnectionManagement, ProviderCatalog } from '@luma/connections';
import { connectionRoutes, createConnectors } from '@luma/connections/http';
import type { CaseService } from '@luma/exceptions';
import { caseRoutes } from '@luma/exceptions/http';
import type { IdentityService, SettingsService } from '@luma/identity';
import { IdentityError } from '@luma/identity';
import {
  identityRoutes,
  registerIdentityGuards,
  settingsRoutes,
} from '@luma/identity/http';
import type { ModelGateway, Observability, Observation } from '@luma/platform';
import type { ProcurementService } from '@luma/procurement';
import type { SupplierCommitments } from '@luma/procurement/composition';
import { procurementRoutes } from '@luma/procurement/http';
import type {
  DecisionAssignments,
  DecisionQueue,
  FulfillmentWorkspace,
  Insights,
  InventoryWorkspace,
  OperationalMetrics,
  OperationalSummary,
  OrderWorkspace,
  ProcurementContextReader,
  ProductWorkspace,
  RecordExplorer,
  ReturnWorkspace,
} from '@luma/read-models';
import {
  decisionRoutes,
  fulfillmentRoutes,
  insightRoutes,
  inventoryRoutes,
  metricRoutes,
  orderRoutes,
  procurementContextRoutes,
  productRoutes,
  recordRoutes,
  returnRoutes,
} from '@luma/read-models/http';
import type {
  ActivityService,
  DeskService,
  LearningService,
  MeasurementService,
  MetricEvents,
  OperationsOverviewService,
  PlaybookLibrary,
  ShadowService,
} from '@luma/resolution';
import {
  activityRoutes,
  deskRoutes,
  learningRoutes,
  operationsRoutes,
  playbookRoutes,
  registerDeskEvents,
  registerMetricEvents,
  shadowRoutes,
} from '@luma/resolution/http';
import type {
  DraftGeneration,
  DraftTests,
  WorkflowCatalog,
  WorkflowDrafts,
  WorkflowTemplates,
} from '@luma/workflows';
import {
  draftTestRoutes,
  workflowDraftRoutes,
  workflowGenerationRoutes,
  workflowRoutes,
} from '@luma/workflows/http';
import { initServer } from '@ts-rest/fastify';
import type { FastifyServerOptions } from 'fastify';
import Fastify, { LogController } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    modelGateway: ModelGateway | null;
  }

  interface FastifyRequest {
    observation: Observation | null;
  }
}

export interface AppDependencies {
  shadow?: ShadowService;
  activity?: ActivityService;
  playbooks?: PlaybookLibrary;
  workflows?: WorkflowCatalog;
  workflowDrafts?: WorkflowDrafts;
  workflowTemplates?: WorkflowTemplates;
  draftTests?: DraftTests;
  workflowGeneration?: DraftGeneration;
  procurement?: ProcurementService;
  commitments?: SupplierCommitments;
  learning?: LearningService;
  measurements?: MeasurementService;
  desk?: DeskService;
  eventSettings?: { intervalMs: number; lifetimeMs: number };
  operations?: OperationsOverviewService;
  metrics?: OperationalMetrics;
  operationalSummary?: OperationalSummary;
  records?: RecordExplorer;
  inventory?: InventoryWorkspace;
  products?: ProductWorkspace;
  procurementContext?: ProcurementContextReader;
  fulfillment?: FulfillmentWorkspace;
  returns?: ReturnWorkspace;
  orders?: OrderWorkspace;
  decisions?: DecisionQueue;
  decisionAssignments?: DecisionAssignments;
  insights?: Insights;
  sync?: SyncService;
  metricEvents?: MetricEvents;
  apps?: AppService;
  appRegistry?: AppRegistry;
  cases?: CaseService;
  connections?: ConnectionManagement;
  modelGateway?: ModelGateway;
  identity?: IdentityService;
  settings?: SettingsService;
  trustedOrigins?: readonly string[];
  providerCatalog?: ProviderCatalog;
  observability?: Observability;
  /** Returns whether the services required to handle requests are available. */
  checkReadiness?: () => Promise<boolean>;
  readinessTimeoutMs?: number;
}

/**
 * Creates an HTTP server with validated routes, tenant guards, and request tracing. Call
 * listen to accept connections and close to shut down.
 */
export function buildApp(
  options: FastifyServerOptions = {},
  dependencies: AppDependencies = {},
) {
  const app = Fastify({
    ...options,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    logController: new LogController({ disableRequestLogging: true }),
  });
  // Node's idle-connection cleanup excludes TCP preconnections that never sent HTTP.
  const preconnections = new Set<Socket>();
  app.server.on('connection', (socket) => {
    preconnections.add(socket);
    socket.once('close', () => preconnections.delete(socket));
  });
  app.server.on('request', (request) => preconnections.delete(request.socket));
  app.addHook('preClose', async () => {
    for (const socket of preconnections) socket.destroy();
    preconnections.clear();
  });
  app.decorate('modelGateway', dependencies.modelGateway ?? null);
  app.decorateRequest('observation', null);
  app.addHook('onResponse', async (request, reply) => {
    const observation = request.observation;
    observation?.end(reply.statusCode >= 500 ? 'error' : 'ok');
    if (
      observation?.context.actionId &&
      reply.statusCode === 200 &&
      request.routeOptions.url === '/v1/connector-providers/:providerId'
    ) {
      dependencies.observability?.capture(
        observation.context,
        'connector_provider_viewed',
      );
    }
    request.log.info(
      { traceId: observation?.context.traceId, statusCode: reply.statusCode },
      'Request completed',
    );
  });
  app.addHook('onRequestAbort', async (request) => {
    request.observation?.end('error');
  });
  app.addHook('onTimeout', async (request) => {
    request.observation?.end('error');
  });
  app.addHook('onClose', async () => {
    await dependencies.observability?.shutdown();
  });
  const s = initServer();
  registerIdentityGuards(
    app,
    dependencies.identity,
    dependencies.trustedOrigins,
  );
  app.addHook('preHandler', async (request) => {
    if (
      request.tenantContext &&
      request.observation &&
      dependencies.observability
    ) {
      const { tenantId, dataRegion } = request.tenantContext;
      request.observation = {
        ...request.observation,
        context: dependencies.observability.forTenant(
          request.observation.context,
          tenantId,
          dataRegion,
        ),
      };
    }
  });
  let draining = false;
  app.addHook('preClose', async () => {
    draining = true;
  });
  app.addHook('onRequest', (request, reply, done) => {
    const actionId = request.headers['x-luma-action-id'];
    const observation = dependencies.observability?.request(
      request.id,
      typeof actionId === 'string' ? actionId : undefined,
      {
        route: request.routeOptions.url ?? 'unmatched',
        method: request.method,
      },
    );
    if (observation) {
      request.observation = observation;
      reply.header('x-trace-id', observation.context.traceId);
    }
    reply.header('x-request-id', request.id);
    reply.header('cache-control', 'no-store');
    if (observation && dependencies.observability?.withContext)
      dependencies.observability.withContext(observation.context, done);
    else done();
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof IdentityError) {
      return reply.status(error.statusCode).send({
        code: error.code,
        message:
          error.statusCode === 404 &&
          request.routeOptions.url?.startsWith(
            '/v1/organizations/:organizationId/exceptions',
          )
            ? 'Case not found'
            : error.message,
        requestId: request.id,
      });
    }
    const status =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? error.statusCode
        : undefined;
    const errors: Record<number, Pick<ApiError, 'code' | 'message'>> = {
      400: { code: 'VALIDATION_ERROR', message: 'Invalid request' },
      413: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' },
      415: {
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'Unsupported media type',
      },
    };
    const knownError = typeof status === 'number' ? errors[status] : undefined;
    // Errors marked `expose` carry a message written for the person making the request.
    const message =
      knownError &&
      typeof error === 'object' &&
      error !== null &&
      'expose' in error &&
      error.expose === true &&
      error instanceof Error
        ? error.message
        : knownError?.message;
    if (!knownError) {
      if (request.observation)
        dependencies.observability?.captureError(request.observation.context);
      request.log.error(
        { traceId: request.observation?.context.traceId },
        'Request failed',
      );
    }
    reply.status(knownError && typeof status === 'number' ? status : 500).send({
      ...(knownError
        ? { code: knownError.code, message }
        : { code: 'INTERNAL_ERROR', message: 'Internal server error' }),
      requestId: request.id,
    });
  });
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      code: 'NOT_FOUND',
      message: 'Route not found',
      requestId: request.id,
    });
  });
  app.register(async (routerApp) => {
    s.registerRouter(
      apiContract,
      {
        shadow: shadowRoutes(dependencies.shadow),
        activity: activityRoutes(dependencies.activity),
        playbooks: playbookRoutes(dependencies.playbooks),
        workflows: workflowRoutes(dependencies.workflows),
        workflowDrafts: workflowDraftRoutes(
          dependencies.workflowDrafts,
          dependencies.workflowTemplates,
        ),
        draftTests: draftTestRoutes(dependencies.draftTests),
        workflowGeneration: workflowGenerationRoutes(
          dependencies.workflowGeneration,
        ),
        procurement: procurementRoutes(
          dependencies.procurement,
          dependencies.commitments,
        ),
        exceptions: caseRoutes(dependencies.cases),
        caseDesk: deskRoutes(dependencies.desk),
        resolutionLearning: learningRoutes(dependencies.learning),
        operations: operationsRoutes(
          dependencies.operations,
          dependencies.measurements,
        ),
        metrics: metricRoutes(
          dependencies.metrics,
          dependencies.operationalSummary,
        ),
        identity: identityRoutes(dependencies.identity),
        settings: settingsRoutes(dependencies.settings),
        apps: appRoutes(dependencies.apps),
        connections: connectionRoutes(dependencies.connections),
        system: {
          health: async () => ({ status: 200, body: { status: 'ok' } }),
          ready: async ({ request }) => {
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
              const ready =
                !draining &&
                (await Promise.race([
                  Promise.resolve().then(
                    () => dependencies.checkReadiness?.() ?? true,
                  ),
                  new Promise<boolean>((resolve) => {
                    timeout = setTimeout(
                      () => resolve(false),
                      dependencies.readinessTimeoutMs ?? 1000,
                    );
                  }),
                ]));
              if (ready && !draining)
                return { status: 200, body: { status: 'ready' } };
            } catch {
              if (request.observation)
                dependencies.observability?.captureError(
                  request.observation.context,
                );
              request.log.error('Readiness check failed');
            } finally {
              clearTimeout(timeout);
            }

            return {
              status: 503,
              body: {
                code: 'NOT_READY',
                message: 'Service is not ready',
                requestId: request.id,
              },
            };
          },
        },
        connectorProviders: createConnectors(dependencies.providerCatalog),
        records: recordRoutes(dependencies.records),
        inventory: inventoryRoutes(dependencies.inventory),
        products: productRoutes(dependencies.products),
        procurementContext: procurementContextRoutes(
          dependencies.procurementContext,
        ),
        fulfillment: fulfillmentRoutes(dependencies.fulfillment),
        orders: orderRoutes(dependencies.orders),
        returns: returnRoutes(dependencies.returns),
        sync: syncRoutes(dependencies.sync),
        decisions: decisionRoutes(
          dependencies.decisions,
          dependencies.decisionAssignments,
        ),
        insights: insightRoutes(dependencies.insights),
      },
      routerApp,
      {
        responseValidation: true,
        requestValidationErrorHandler: (_error, request, reply) => {
          void reply.status(400).send({
            code: 'VALIDATION_ERROR',
            message: 'Invalid request',
            requestId: request.id,
          });
        },
      },
    );
  });
  dependencies.appRegistry?.registerHttp(app, dependencies.identity);
  registerDeskEvents(
    app,
    dependencies.desk,
    dependencies.identity,
    dependencies.eventSettings,
  );
  registerMetricEvents(app, dependencies.metricEvents, dependencies.identity);
  app.get('/openapi.json', async () => openApiDocument);

  return app;
}
