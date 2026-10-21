import { apiContract } from '@luma/api-contract';
import { ServiceError, unavailable } from '@luma/platform';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { ApiAppsService } from '../application/api-apps.js';
import { apiAppScopes } from '../domain/api-apps.js';
import { permissionCatalog } from '../domain/permissions.js';
import type { HttpContext } from './contract-routes.js';

/** Routes personal API app management; a signed-in member's context is required. */
export function apiAppsRoutes(service?: ApiAppsService) {
  const use = () => {
    if (!service) throw unavailable('API apps are unavailable');

    return service;
  };
  const context = (request: FastifyRequest) => {
    if (!request.tenantContext)
      throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');

    return request.tenantContext;
  };

  const os = implement(apiContract.apiApps).$context<HttpContext>();

  return os.router({
    list: os.list.handler(async ({ context: { request } }) => ({
      items: await use().list(context(request)),
      scopes: apiAppScopes.map((key) => ({
        key,
        sensitive:
          permissionCatalog.find((permission) => permission.key === key)
            ?.consequential ?? true,
      })),
    })),
    create: os.create.handler(
      async ({ context: { request }, input: { headers, body } }) =>
        await use().create(context(request), {
          commandId: headers['x-command-id'],
          ...body,
        }),
    ),
    rotate: os.rotate.handler(
      async ({ context: { request }, input: { params, headers, body } }) =>
        await use().rotate(context(request), params.appId, {
          commandId: headers['x-command-id'],
          ...body,
        }),
    ),
    revoke: os.revoke.handler(
      async ({ context: { request }, input: { params, headers } }) =>
        await use().revoke(context(request), params.appId, {
          commandId: headers['x-command-id'],
        }),
    ),
  });
}
