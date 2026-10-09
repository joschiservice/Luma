import '@luma/identity/http';

import { apiContract, installedConnectionSchema } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { InstallationService } from '../application/installations.js';

type ConnectionManagement = Omit<
  InstallationService,
  'credential' | 'recordFailure'
>;

/**
 * Creates authenticated connection-management handlers; returns service unavailable when
 * management is not configured.
 */
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

  const os = implement(apiContract.connections).$context<HttpContext>();

  return os.router({
    list: os.list.handler(async ({ context: { request } }) => {
      const { service, context } = use(request);

      return { items: (await service.list(context)).map(summary) };
    }),
    install: os.install.handler(
      async ({ context: { request }, input: { body } }) => {
        const { service, context } = use(request);

        return summary(await service.install(context, body));
      },
    ),
    check: os.check.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const { service, context } = use(request);

        return summary(
          await service.check(context, params.connectionId, body.version),
        );
      },
    ),
    rotate: os.rotate.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const { service, context } = use(request);

        return summary(
          await service.rotate(
            context,
            params.connectionId,
            body.version,
            body.credentials,
          ),
        );
      },
    ),
    disconnect: os.disconnect.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const { service, context } = use(request);

        return summary(
          await service.disconnect(context, params.connectionId, body.version),
        );
      },
    ),
  });
}
