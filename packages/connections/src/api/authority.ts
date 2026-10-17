import { apiContract } from '@luma/api-contract';
import type { HttpContext } from '@luma/identity/http';
import { ServiceError, unavailable } from '@luma/platform';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { AuthoritySettings } from '../application/authority.js';

/** Serves tenant-scoped authority settings and immutable change history. */
export function sourceAuthorityRoutes(service?: AuthoritySettings) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service) throw unavailable('Source authority is unavailable');

    return { service, context: request.tenantContext };
  }

  const os = implement(apiContract.sourceAuthority).$context<HttpContext>();

  return os.router({
    get: os.get.handler(({ context: { request } }) => {
      const { service, context } = use(request);

      return service.read(context);
    }),
    change: os.change.handler(({ context: { request }, input: { body } }) => {
      const { service, context } = use(request);

      return service.change(context, body);
    }),
    history: os.history.handler(async ({ context: { request } }) => {
      const { service, context } = use(request);

      return { items: await service.history(context) };
    }),
  });
}
