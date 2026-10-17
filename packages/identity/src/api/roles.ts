import { apiContract } from '@luma/api-contract';
import { ServiceError, unavailable } from '@luma/platform';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { RolesService } from '../application/roles.js';
import type { HttpContext } from './contract-routes.js';

/** Routes role reads and command-identified role changes through the roles service. */
export function rolesRoutes(service?: RolesService) {
  const use = () => {
    if (!service) throw unavailable('Roles are unavailable');

    return service;
  };
  const context = (request: FastifyRequest) => {
    if (!request.tenantContext)
      throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');

    return request.tenantContext;
  };

  const os = implement(apiContract.roles).$context<HttpContext>();

  return os.router({
    list: os.list.handler(async ({ context: { request } }) =>
      use().list(context(request)),
    ),
    create: os.create.handler(
      async ({ context: { request }, input: { headers, body } }) =>
        use().create(context(request), headers['x-command-id'], body),
    ),
    update: os.update.handler(
      async ({ context: { request }, input: { params, headers, body } }) =>
        use().update(
          context(request),
          params.roleId,
          headers['x-command-id'],
          body,
        ),
    ),
    archive: os.archive.handler(
      async ({ context: { request }, input: { params, headers, body } }) =>
        use().archive(
          context(request),
          params.roleId,
          headers['x-command-id'],
          body,
        ),
    ),
    history: os.history.handler(
      async ({ context: { request }, input: { params } }) => ({
        items: await use().history(context(request), params.roleId),
      }),
    ),
  });
}
