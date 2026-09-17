import { Pool } from 'pg';
import { createTenantDatabase } from './modules/platform/composition.js';
import { createPolicies } from './modules/policies/composition.js';
import { createAuditLog } from './modules/audit/composition.js';
import { createExecution } from './modules/execution/composition.js';
import type { EffectRegistry } from './modules/connectors/index.js';
import { randomUUID } from 'node:crypto';
import type { Observation, Observability } from './modules/platform/index.js';
import { apiContract } from '@luma/api-contract';
import type { ApiError } from '@luma/api-contract';
import { openApiDocument } from '@luma/api-contract/openapi';
import { initServer } from '@ts-rest/fastify';
import Fastify, { LogController } from 'fastify';
import type { FastifyServerOptions } from 'fastify';
import { createConnectors } from './modules/connectors/composition.js';
import type { ProviderCatalog } from './modules/connectors/index.js';

import {
  createIdentity,
  identityRoutes,
  registerIdentityGuards,
} from './modules/identity/composition.js';
import { IdentityError } from './modules/identity/index.js';
import type { IdentityService } from './modules/identity/index.js';

export interface AppDependencies {
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
        message: error.message,
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
        identity: identityRoutes(dependencies.identity),
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
  app.get('/openapi.json', async () => openApiDocument);
  return app;
}

export function buildRuntimeApp(
  settings: Parameters<typeof createIdentity>[0],
  options: FastifyServerOptions = {},
  observability?: Observability,
) {
  const identity = createIdentity(settings);
  const app = buildApp(options, {
    ...(observability ? { observability } : {}),
    identity: identity.service,
    trustedOrigins: settings.trustedOrigins,
    checkReadiness: identity.checkReadiness,
  });
  identity.register(app);
  app.addHook('onClose', identity.close);
  return app;
}

declare module 'fastify' {
  interface FastifyRequest {
    observation: Observation | null;
  }
}

/** Creates the policy and execution services used by workflow activities. */
export function createSafetyServices(
  databaseUrl: string,
  identity: Pick<IdentityService, 'refreshContext'>,
  registry: EffectRegistry,
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
    async (evidence) => {
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
    },
  );
  return {
    policies,
    execution: createExecution(
      db,
      policies,
      audit,
      registry,
      identity.refreshContext,
    ),
    close: () => pool.end(),
  };
}
