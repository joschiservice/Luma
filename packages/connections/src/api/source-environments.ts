import { apiContract } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { SourceEnvironments } from '../application/source-environment.js';

/** Serves authorized versioned source declarations; credentials are never part of these responses. */
export function sourceEnvironmentRoutes(service?: SourceEnvironments) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Source review is unavailable',
      );

    return { service, context: request.tenantContext };
  }

  const os = implement(apiContract.sourceEnvironments).$context<HttpContext>();

  return os.router({
    list: os.list.handler(({ context: { request } }) => {
      const { service, context } = use(request);

      return service.list(context);
    }),
    inspect: os.inspect.handler(
      async ({ context: { request, reply }, input: { params } }) => {
        const { service, context } = use(request);
        const cancellation = new AbortController();
        const abort = () => {
          if (!reply.raw.writableEnded) cancellation.abort();
        };
        request.raw.once('aborted', abort);
        reply.raw.once('close', abort);
        try {
          return await service.inspect(
            context,
            params.connectionId,
            cancellation.signal,
          );
        } finally {
          request.raw.off('aborted', abort);
          reply.raw.off('close', abort);
        }
      },
    ),
    change: os.change.handler(
      ({ context: { request }, input: { params, body } }) => {
        const { service, context } = use(request);

        return service.change(context, params.connectionId, body);
      },
    ),
  });
}
