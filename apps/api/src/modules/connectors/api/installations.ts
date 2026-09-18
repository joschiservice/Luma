import { initServer } from '@ts-rest/fastify';
import type { FastifyRequest } from 'fastify';
import { apiContract, installedConnectionSchema } from '@luma/api-contract';
import { IdentityError } from '../../identity/index.js';
import type { InstallationService } from '../application/installations.js';
type ConnectionManagement = Omit<InstallationService, 'credential'>;

export function connectionRoutes(service?: ConnectionManagement) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Connection service is unavailable',
      );
    return { service, context: request.tenantContext };
  }
  // Parse summaries before serialization so credentials can never become response fields.
  const summary = (value: unknown) => installedConnectionSchema.parse(value);
  return initServer().router(apiContract.connections, {
    list: async ({ request }) => {
      const { service, context } = use(request);
      return {
        status: 200,
        body: { items: (await service.list(context)).map(summary) },
      };
    },
    install: async ({ request, body }) => {
      const { service, context } = use(request);
      return {
        status: 201,
        body: summary(await service.install(context, body)),
      };
    },
    check: async ({ request, params, body }) => {
      const { service, context } = use(request);
      return {
        status: 200,
        body: summary(
          await service.check(context, params.connectionId, body.version),
        ),
      };
    },
    rotate: async ({ request, params, body }) => {
      const { service, context } = use(request);
      return {
        status: 200,
        body: summary(
          await service.rotate(
            context,
            params.connectionId,
            body.version,
            body.credentials,
          ),
        ),
      };
    },
    disconnect: async ({ request, params, body }) => {
      const { service, context } = use(request);
      return {
        status: 200,
        body: summary(
          await service.disconnect(context, params.connectionId, body.version),
        ),
      };
    },
  });
}
