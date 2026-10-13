import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';

import type { FieldWorkflowAdapter } from '@luma/adaptive';
import {
  adaptiveAvailabilityRoutes,
  fieldsRoutes,
  operationalPackageRoutes,
  viewActionRoutes,
  viewsRoutes,
} from '@luma/adaptive/http';
import type { ApiError } from '@luma/api-contract';
import { apiContract } from '@luma/api-contract';
import { openApiDocument } from '@luma/api-contract/openapi';
import type { AppRegistry, AppService } from '@luma/app-host';
import { appRoutes } from '@luma/app-host/http';
import type { Assistant } from '@luma/assistant';
import { assistantRoutes } from '@luma/assistant/http';
import type { SyncService } from '@luma/commerce-sync';
import { syncRoutes } from '@luma/commerce-sync/http';
import type {
  AuthoritySettings,
  ConnectionManagement,
  ProviderCatalog,
} from '@luma/connections';
import {
  connectionRoutes,
  createConnectors,
  sourceAuthorityRoutes,
} from '@luma/connections/http';
import type { CaseService } from '@luma/exceptions';
import { caseRoutes } from '@luma/exceptions/http';
import type {
  IdentityService,
  RolesService,
  SettingsService,
} from '@luma/identity';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import {
  identityRoutes,
  registerContractRoutes,
  registerIdentityGuards,
  rolesRoutes,
  settingsRoutes,
} from '@luma/identity/http';
import type { NativeStockRuntime } from '@luma/inventory';
import { nativeStockRoutes } from '@luma/inventory/http';
import type {
  DocumentService,
  MessagingService,
  Replies,
} from '@luma/messaging';
import { messagingRoutes } from '@luma/messaging/http';
import type {
  ReturnActions,
  ReturnCases,
  ReturnDeadlines,
  ReturnExchanges,
} from '@luma/orders/composition';
import { returnCaseRoutes } from '@luma/orders/http';
import type { ModelGateway, Observability, Observation } from '@luma/platform';
import { describeError } from '@luma/platform';
import type { ProcurementService } from '@luma/procurement';
import type {
  createIncomingStock,
  PurchaseOrderChanges,
  PurchasingOutcomes,
  PurchasingService,
  SupplierCommitments,
  SupplierEmail,
  SupplierTermsService,
} from '@luma/procurement/composition';
import {
  procurementRoutes,
  purchaseOrderChangeRoutes,
  supplierEmailRoutes,
} from '@luma/procurement/http';
import type {
  CustomerWorkspace,
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
  customerRoutes,
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
import type { SalesService } from '@luma/sales';
import { salesRoutes } from '@luma/sales/http';
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
import { implement } from '@orpc/server';
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
  fieldWorkflows?: FieldWorkflowAdapter;
  adaptive?: ReturnType<
    typeof import('./adaptive.js').createAdaptiveWorkspaceRuntime
  >;
  shadow?: ShadowService;
  activity?: ActivityService;
  playbooks?: PlaybookLibrary;
  workflows?: WorkflowCatalog;
  workflowDrafts?: WorkflowDrafts;
  workflowTemplates?: WorkflowTemplates;
  draftTests?: DraftTests;
  workflowGeneration?: DraftGeneration;
  procurement?: ProcurementService;
  supplierTerms?: SupplierTermsService;
  incoming?: ReturnType<typeof createIncomingStock>;
  purchasing?: PurchasingService;
  purchasingOutcomes?: PurchasingOutcomes;
  commitments?: SupplierCommitments;
  orderChanges?: PurchaseOrderChanges;
  supplierEmail?: SupplierEmail;
  messaging?: MessagingService;
  messagingReplies?: Replies;
  messagingDocuments?: DocumentService;
  learning?: LearningService;
  measurements?: MeasurementService;
  desk?: DeskService;
  eventSettings?: { intervalMs: number; lifetimeMs: number };
  operations?: OperationsOverviewService;
  metrics?: OperationalMetrics;
  operationalSummary?: OperationalSummary;
  records?: RecordExplorer;
  inventory?: InventoryWorkspace;
  nativeStock?: NativeStockRuntime;
  products?: ProductWorkspace;
  procurementContext?: ProcurementContextReader;
  fulfillment?: FulfillmentWorkspace;
  returns?: ReturnWorkspace;
  returnCases?: ReturnCases;
  returnActions?: ReturnActions;
  returnExchanges?: ReturnExchanges;
  returnDeadlines?: ReturnDeadlines;
  customers?: CustomerWorkspace;
  orders?: OrderWorkspace;
  sales?: SalesService;
  decisions?: DecisionQueue;
  decisionAssignments?: DecisionAssignments;
  insights?: Insights;
  assistant?: Assistant;
  sync?: SyncService;
  metricEvents?: MetricEvents;
  apps?: AppService;
  appRegistry?: AppRegistry;
  cases?: CaseService;
  connections?: ConnectionManagement;
  sourceAuthority?: AuthoritySettings;
  modelGateway?: ModelGateway;
  identity?: IdentityService;
  settings?: SettingsService;
  roles?: RolesService;
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
  let draining = false;
  const preconnections = new Set<Socket>();
  app.server.on('connection', (socket) => {
    if (draining) {
      socket.destroy();

      return;
    }
    preconnections.add(socket);
    socket.once('close', () => preconnections.delete(socket));
  });
  app.server.on('request', (request, response) => {
    preconnections.delete(request.socket);
    response.once('finish', () => {
      // Shutdown checks idle sockets once; a response finishing later can leave its
      // keep-alive connection open unless the new idle socket is checked again.
      if (draining) app.server.closeIdleConnections();
    });
  });
  app.addHook('preClose', async () => {
    draining = true;
    // Idle cleanup excludes accepted TCP connections that have not sent HTTP headers.
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
      const route = request.routeOptions.url ?? 'unmatched';
      if (request.observation)
        dependencies.observability?.captureError(error, {
          context: request.observation.context,
          request: {
            method: request.method,
            route,
            url: request.url,
            headers: request.headers,
          },
        });
      request.log.error(
        {
          traceId: request.observation?.context.traceId,
          method: request.method,
          route,
          error: describeError(error),
        },
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
  const os = implement(apiContract).$context<HttpContext>();
  registerContractRoutes(
    app,
    apiContract,
    os.router({
      adaptive: adaptiveAvailabilityRoutes(dependencies.adaptive?.availability),
      adaptiveFields: fieldsRoutes(
        dependencies.adaptive?.fields,
        dependencies.fieldWorkflows,
      ),
      adaptiveViews: viewsRoutes(dependencies.adaptive?.views),
      adaptiveActions: viewActionRoutes(dependencies.adaptive?.actions),
      adaptivePackages: operationalPackageRoutes(
        dependencies.adaptive?.packages,
      ),
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
      procurementChanges: purchaseOrderChangeRoutes(dependencies.orderChanges),
      procurement: procurementRoutes(
        dependencies.procurement,
        dependencies.commitments,
        dependencies.supplierTerms,
        dependencies.purchasing,
        dependencies.purchasingOutcomes,
        dependencies.incoming,
      ),
      procurementEmail: supplierEmailRoutes(
        dependencies.supplierEmail,
        dependencies.procurement,
      ),
      messaging: messagingRoutes(
        dependencies.messaging,
        dependencies.messagingReplies,
        dependencies.messagingDocuments,
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
      roles: rolesRoutes(dependencies.roles),
      apps: appRoutes(dependencies.apps),
      connections: connectionRoutes(
        dependencies.connections,
        dependencies.sales?.enabled,
      ),
      sourceAuthority: sourceAuthorityRoutes(dependencies.sourceAuthority),
      system: {
        health: os.system.health.handler(() => ({ status: 'ok' as const })),
        ready: os.system.ready.handler(async ({ context: { request } }) => {
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
            if (ready && !draining) return { status: 'ready' as const };
          } catch (error) {
            if (request.observation)
              dependencies.observability?.captureError(error, {
                context: request.observation.context,
                message: 'Readiness check failed',
              });
            request.log.error(
              { error: describeError(error) },
              'Readiness check failed',
            );
          } finally {
            clearTimeout(timeout);
          }

          throw new IdentityError(503, 'NOT_READY', 'Service is not ready');
        }),
      },
      connectorProviders: createConnectors(dependencies.providerCatalog),
      records: recordRoutes(dependencies.records),
      inventory: inventoryRoutes(dependencies.inventory),
      nativeStock: nativeStockRoutes(dependencies.nativeStock),
      products: productRoutes(dependencies.products),
      procurementContext: procurementContextRoutes(
        dependencies.procurementContext,
      ),
      fulfillment: fulfillmentRoutes(dependencies.fulfillment),
      orders: orderRoutes(dependencies.orders),
      sales: salesRoutes(dependencies.sales),
      returns: returnRoutes(dependencies.returns),
      returnCases: returnCaseRoutes(
        dependencies.returnCases,
        dependencies.returnActions,
        dependencies.returnExchanges,
        dependencies.returnDeadlines,
      ),
      customers: customerRoutes(dependencies.customers),
      sync: syncRoutes(dependencies.sync),
      decisions: decisionRoutes(
        dependencies.decisions,
        dependencies.decisionAssignments,
      ),
      insights: insightRoutes(dependencies.insights),
      assistant: assistantRoutes(dependencies.assistant),
    }),
  );
  const apps = dependencies.apps;
  dependencies.appRegistry?.registerHttp(
    app,
    dependencies.identity,
    async (context, operation) => {
      if (!apps)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'App management is unavailable',
        );
      await apps.requirePermission(context, operation);
    },
  );
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
