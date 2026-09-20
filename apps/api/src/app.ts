import {
  createDeskStore,
  createDeskService,
  createDeskWorkflowReader,
  deskRoutes,
  registerDeskEvents,
} from '#modules/workflows/composition';
import { parseAction } from '#modules/execution/composition';
import { createConnectionCoverage } from '#modules/connectors/composition';
import {
  createOperationsOverview,
  operationsRoutes,
} from '#modules/workflows/composition';
import { createSourceRecords } from '#modules/connectors/composition';
import { createCommerceProjections as createOrderProjections } from '#modules/orders/composition';
import { createCommerceProjections as createInventoryProjections } from '#modules/inventory/composition';
import { createCommerceIngestion } from '#modules/workflows/index';
import {
  createExceptionActivities,
  createExceptionClient,
  createExceptionWorker,
} from '#modules/workflows/composition';
import type { TemporalSettings } from '#modules/workflows/composition';
import type { WorkflowBindings } from '#modules/workflows/index';
import type {
  DiagnosisOptions,
  VerificationEvaluator,
} from '#modules/exceptions/index';
import {
  createCases,
  createCaseEscalation,
  caseRoutes,
  createDiagnoses,
  createExceptions,
} from '#modules/exceptions/composition';
import { createDetectionPipeline } from '#modules/workflows/index';
import { Pool } from 'pg';
import type { ConnectionsConfig, ModelGatewayConfig } from '@luma/config';
import {
  createModelGateway,
  createTenantDatabase,
} from '#modules/platform/composition';
import { createPolicies } from '#modules/policies/composition';
import { createAuditLog } from '#modules/audit/composition';
import {
  createExecution,
  createAdmission,
  createAdmissionStore,
} from '#modules/execution/composition';
import type { EffectRegistry } from '#modules/connectors/index';
import { randomUUID, createHash } from 'node:crypto';
import type {
  ModelGateway,
  Observation,
  Observability,
} from '#modules/platform/index';
import { apiContract } from '@luma/api-contract';
import type { ApiError } from '@luma/api-contract';
import { openApiDocument } from '@luma/api-contract/openapi';
import { initServer } from '@ts-rest/fastify';
import Fastify, { LogController } from 'fastify';
import type { FastifyServerOptions } from 'fastify';
import {
  connectionRoutes,
  registerShopifyRoutes,
  createConnectors,
  createInstalledConnections,
  createInstallationVerifier,
} from '#modules/connectors/composition';
import type { ProviderCatalog } from '#modules/connectors/index';

import {
  createIdentity,
  identityRoutes,
  registerIdentityGuards,
} from '#modules/identity/composition';
import { IdentityError } from '#modules/identity/index';
import type { IdentityService } from '#modules/identity/index';

export interface AppDependencies {
  desk?: import('#modules/workflows/index').DeskService;
  eventSettings?: { intervalMs: number; lifetimeMs: number };
  operations?: import('#modules/workflows/index').OperationsOverviewService;
  shopify?: import('#modules/connectors/composition').ShopifyOAuth;
  cases?: import('#modules/exceptions/index').CaseService;
  connections?: import('#modules/connectors/index').ConnectionManagement;
  modelGateway?: ModelGateway;
  identity?: IdentityService;
  trustedOrigins?: readonly string[];
  providerCatalog?: ProviderCatalog;
  observability?: Observability;
  /** Returns whether the services required to handle requests are available. */
  checkReadiness?: () => Promise<boolean>;
  readinessTimeoutMs?: number;
}

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
  app.addHook('onRequest', async (request, reply) => {
    const actionId = request.headers['x-luma-action-id'];
    const observation = dependencies.observability?.request(
      request.id,
      typeof actionId === 'string' ? actionId : undefined,
    );
    if (observation) {
      request.observation = observation;
      reply.header('x-trace-id', observation.context.traceId);
    }
    reply.header('x-request-id', request.id);
    reply.header('cache-control', 'no-store');
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
    if (!knownError) {
      if (request.observation)
        dependencies.observability?.captureError(request.observation.context);
      request.log.error(
        { traceId: request.observation?.context.traceId },
        'Request failed',
      );
    }
    reply.status(knownError && typeof status === 'number' ? status : 500).send({
      ...(knownError ?? {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      }),
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
        exceptions: caseRoutes(dependencies.cases),
        caseDesk: deskRoutes(dependencies.desk),
        operations: operationsRoutes(dependencies.operations),
        identity: identityRoutes(dependencies.identity),
        connections: connectionRoutes(
          dependencies.connections,
          dependencies.shopify,
        ),
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
  registerShopifyRoutes(app, dependencies.shopify, dependencies.identity);
  registerDeskEvents(
    app,
    dependencies.desk,
    dependencies.identity,
    dependencies.eventSettings,
  );
  app.get('/openapi.json', async () => openApiDocument);
  return app;
}

export function buildRuntimeApp(
  settings: Parameters<typeof createIdentity>[0],
  options: FastifyServerOptions = {},
  observability?: Observability,
  modelSettings?: ModelGatewayConfig,
  connections?:
    | ConnectionsConfig
    | ((
        identity: IdentityService,
      ) => import('#modules/connectors/index').ConnectionManagement),
  workflowSettings?: import('@luma/config').WorkflowConfig,
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
    desk,
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

declare module 'fastify' {
  interface FastifyInstance {
    modelGateway: ModelGateway | null;
  }
  interface FastifyRequest {
    observation: Observation | null;
  }
}

/** Creates the policy and execution services used by workflow activities. */
export function createSafetyServices(
  databaseUrl: string,
  identity: Pick<IdentityService, 'refreshContext'>,
  registry: EffectRegistry,
  admissionOptions: {
    eligible(
      context: import('#modules/identity/index').TenantContext,
      step: import('#modules/execution/index').BoundActionStep,
    ): Promise<boolean>;
  } = { eligible: async () => false },
) {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  });
  const db = createTenantDatabase(pool);
  const audit = createAuditLog(db);
  const policies = createPolicies(
    db,
    identity.refreshContext,
    policyAudit(audit),
  );
  const provisioning = createAdmissionStore(db);
  const engine = createExecution(
    db,
    policies,
    audit,
    registry,
    identity.refreshContext,
  );
  return {
    policies,
    provisioning,
    execution: createAdmission({
      repository: provisioning,
      execution: engine,
      refreshContext: identity.refreshContext,
      eligible: admissionOptions.eligible,
    }),
    close: () => pool.end(),
  };
}

/** Create tenant-scoped detection services for connector ingestion and durable workflow events. */
export function createDetectionServices(
  databaseUrl: string,
  now: () => Date = () => new Date(),
  verifier?: VerificationEvaluator,
  diagnosisOptions: DiagnosisOptions = {},
) {
  const pool = new Pool({ connectionString: databaseUrl });
  const exceptions = createExceptions(
    createTenantDatabase(pool),
    now,
    verifier,
  );
  return {
    exceptions,
    cases: createCases(createTenantDatabase(pool), now),
    diagnoses: createDiagnoses(
      createTenantDatabase(pool),
      now,
      diagnosisOptions,
    ),
    pipeline: createDetectionPipeline(exceptions, (value) =>
      createHash('sha256').update(value).digest('hex'),
    ),
    close: () => pool.end(),
  };
}

/** Wire durable activities to the same tenant-scoped services used by commands. */
export function createExceptionWorkflowRuntime(
  settings: TemporalSettings,
  identity: Pick<IdentityService, 'refreshContext' | 'resolveWorkflowContext'>,
  detection: Pick<
    ReturnType<typeof createDetectionServices>,
    'exceptions' | 'diagnoses'
  >,
  safety: Pick<
    ReturnType<typeof createSafetyServices>,
    'execution' | 'provisioning'
  >,
  bindings: WorkflowBindings,
  desk?: import('#modules/workflows/index').DeskService,
  artifactReference = { id: 'exception-resolution', version: '1' },
) {
  if (desk) bindings = { ...bindings, recordWorkflow: desk.bindWorkflow };
  if (desk && bindings.proposals) {
    const proposals = bindings.proposals;
    bindings = {
      ...bindings,
      proposals: {
        prepare: async (context, diagnosis) => {
          const action = await proposals.prepare(context, diagnosis);
          if (action)
            await desk.publish(
              context,
              diagnosis.exceptionId,
              diagnosis.revision,
              action,
            );
          return action;
        },
        get: desk.proposal,
      },
    };
  }
  if (bindings.proposals) {
    const proposals = bindings.proposals;
    bindings = {
      ...bindings,
      proposals: {
        ...proposals,
        prepare: async (context, diagnosis) => {
          const action = await proposals.prepare(context, diagnosis);
          if (!action) return null;
          const artifact = await safety.provisioning.artifact(
            context,
            artifactReference.id,
            artifactReference.version,
          );
          if (!artifact?.active) return null;
          await safety.provisioning.bind(context, {
            runId: action.id,
            stepId: 'execute',
            tenantId: context.tenantId,
            principalId: context.actor.id,
            artifactId: artifact.id,
            artifactVersion: artifact.version,
            artifactDigest: artifact.digest,
            incidentId: diagnosis.exceptionId,
            diagnosisRevision: diagnosis.revision,
            action,
          });
          return action;
        },
      },
    };
  }
  const activities = createExceptionActivities({
    identity,
    ...detection,
    execution: safety.execution,
    bindings,
  });
  return {
    createClient: () => createExceptionClient(settings, identity),
    createWorker: () => createExceptionWorker(settings, activities),
  };
}

/** Recheck the bound diagnosis and its evidence independently of workflow decisions. */
export function createAdmissionEligibility(
  diagnoses: Pick<import('#modules/exceptions/index').DiagnosisService, 'get'>,
  maxEvidenceAgeMs = 5 * 60_000,
) {
  if (!Number.isFinite(maxEvidenceAgeMs) || maxEvidenceAgeMs <= 0)
    throw new Error('Evidence freshness window must be positive');
  return async (
    context: import('#modules/identity/index').TenantContext,
    step: import('#modules/execution/index').BoundActionStep,
  ) => {
    const diagnosis = await diagnoses.get(context, step.incidentId);
    const now = Date.now();
    return (
      !!diagnosis &&
      diagnosis.exceptionId === step.incidentId &&
      !diagnosis.superseded &&
      diagnosis.status === 'ready' &&
      diagnosis.revision === step.diagnosisRevision &&
      (diagnosis.provenance.validUntil === null ||
        Date.parse(diagnosis.provenance.validUntil) > now) &&
      Date.parse(step.action.preconditions.validUntil) > now &&
      step.action.preconditions.evidenceRefs.every((id) => {
        const evidence = diagnosis.provenance.evidence.find(
          (evidence) => evidence.id === id,
        );
        const observedAt = Date.parse(evidence?.observedAt ?? '');
        return observedAt <= now && observedAt + maxEvidenceAgeMs > now;
      })
    );
  };
}

/** Start a worker for persisted incidents and diagnoses. */
export async function createDefaultExceptionWorker(
  identitySettings: Parameters<typeof createIdentity>[0],
  settings: import('@luma/config').WorkflowConfig,
) {
  const identity = createIdentity(identitySettings);
  const detection = createDetectionServices(settings.databaseUrl);
  const safety = createSafetyServices(
    settings.databaseUrl,
    identity.service,
    {
      resolve: async () => null,
    },
    { eligible: createAdmissionEligibility(detection.diagnoses) },
  );
  const deskPool = new Pool({ connectionString: settings.databaseUrl, max: 5 });
  const desk = createDeskServices(
    createTenantDatabase(deskPool),
    identity.service,
  );
  const closeServices = async () => {
    await Promise.all([
      identity.close(),
      detection.close(),
      safety.close(),
      deskPool.end(),
    ]);
  };
  try {
    const runtime = createExceptionWorkflowRuntime(
      settings.temporal,
      identity.service,
      detection,
      safety,
      {
        loadDetection: async () => null,
        proposals: {
          prepare: async (context, diagnosis) => {
            const review = await desk.review(context, diagnosis.exceptionId);
            if (review.proposal?.diagnosisRevision !== diagnosis.revision)
              return null;
            return (
              (await desk.proposal(context, review.proposal.id))?.action ?? null
            );
          },
          get: desk.proposal,
        },
      },
      desk,
    );
    const worker = await runtime.createWorker();
    return {
      run: worker.run,
      shutdown: worker.shutdown,
      close: async () => {
        try {
          await worker.close();
        } finally {
          await closeServices();
        }
      },
    };
  } catch (error) {
    await closeServices();
    throw error;
  }
}

/** Persist connector observations and replay canonical projections in owner transactions. */
export function createCommerceServices(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = createTenantDatabase(pool);
  const inventory = createInventoryProjections(db);
  const orders = createOrderProjections(db, (context, id) =>
    inventory.has(context, 'sku', id),
  );
  const sources = createSourceRecords(db, (context, kind, id) =>
    kind === 'order' || kind === 'order_line' || kind === 'fulfillment'
      ? orders.has(context, kind, id)
      : inventory.has(context, kind, id),
  );
  return {
    sources,
    orders,
    inventory,
    ingestion: createCommerceIngestion(sources, orders, inventory, (value) =>
      createHash('sha256').update(value).digest('hex'),
    ),
    close: () => pool.end(),
  };
}

/** Connect the operator boundary to persisted proposals and the existing policy authority. */
export function createDeskServices(
  db: import('#modules/platform/index').TenantDatabase,
  identity: Pick<IdentityService, 'refreshContext'>,
  effects: EffectRegistry = { resolve: async () => null },
  options: {
    capability?: (
      action: import('#modules/policies/index').ProposedAction,
    ) => boolean;
    workflow?: import('#modules/workflows/index').DeskDependencies['workflow'];
    now?: () => Date;
  } = {},
) {
  const store = createDeskStore(db, {
    parseAction,
    escalate: (scoped, context, id, revision) =>
      createCaseEscalation(scoped)(context, id, revision),
    policies: (scoped) =>
      createPolicies(
        scoped,
        identity.refreshContext,
        policyAudit(createAuditLog(scoped)),
      ),
  });
  return createDeskService({
    store,
    refreshContext: identity.refreshContext,
    capability: options.capability ?? (() => false),
    checkCapability: async (context, action) => {
      const adapter = await effects.resolve(context, action);
      return (
        !!adapter &&
        adapter.capability === action.capability &&
        adapter.version === action.capabilityVersion &&
        (await adapter.checkPreconditions(action))
      );
    },
    now: options.now ?? (() => new Date()),
    ...(options.workflow ? { workflow: options.workflow } : {}),
  });
}

export function policyAudit(audit: import('#modules/audit/index').AuditLog) {
  return async (evidence: import('#modules/policies/index').PolicyEvidence) => {
    const item = evidence.document;
    await audit.append({
      id: item.id,
      tenantId: item.tenantId,
      eventKey: item.id,
      eventType: evidence.type,
      schemaVersion: 1,
      occurredAt: 'evaluatedAt' in item ? item.evaluatedAt : item.createdAt,
      actor: {
        kind: 'user',
        id: 'actorId' in item ? item.actorId : item.approverId,
      },
      correlationId: item.correlationId,
      proposalId: item.proposalId,
      actionHash: item.actionHash,
      policyDecisionId: 'actorId' in item ? item.id : item.decisionId,
      evidenceRefs: [],
      details: {
        outcome: item.outcome,
        policyVersion: item.policyVersion,
        ...('reason' in item
          ? { reason: item.reason }
          : { requesterId: item.requesterId, expiresAt: item.expiresAt }),
      },
    });
  };
}
