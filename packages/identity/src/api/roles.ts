import { apiContract } from '@luma/api-contract';
import { initServer } from '@ts-rest/fastify';
import type { FastifyRequest } from 'fastify';

import type { RolesService } from '../application/roles.js';
import { IdentityError } from '../domain/context.js';

/** Routes role reads and command-identified role changes through the roles service. */
export function rolesRoutes(service?: RolesService) {
  const use = () => {
    if (!service)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Roles are unavailable',
      );

    return service;
  };
  const context = (request: FastifyRequest) => {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');

    return request.tenantContext;
  };

  return initServer().router(apiContract.roles, {
    list: async ({ request }) => ({
      status: 200,
      body: await use().list(context(request)),
    }),
    create: async ({ request, headers, body }) => ({
      status: 201,
      body: await use().create(context(request), headers['x-command-id'], body),
    }),
    update: async ({ request, params, headers, body }) => ({
      status: 200,
      body: await use().update(
        context(request),
        params.roleId,
        headers['x-command-id'],
        body,
      ),
    }),
    archive: async ({ request, params, headers, body }) => ({
      status: 200,
      body: await use().archive(
        context(request),
        params.roleId,
        headers['x-command-id'],
        body,
      ),
    }),
    history: async ({ request, params }) => ({
      status: 200,
      body: { items: await use().history(context(request), params.roleId) },
    }),
  });
}
