import '@luma/identity/http';

import { apiContract } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import { initServer } from '@ts-rest/fastify';
import type { FastifyRequest } from 'fastify';

import type { AppService } from './index.js';

/** Exposes tenant-authorized app catalog and installation commands. */
export function appRoutes(apps?: AppService) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!apps)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'App management is unavailable',
      );

    return { apps, context: request.tenantContext };
  }

  return initServer().router(apiContract.apps, {
    list: async ({ request }) => {
      const { apps, context } = use(request);

      return { status: 200, body: await apps.list(context) };
    },
    install: async ({ request, params, body }) => {
      const { apps, context } = use(request);

      return {
        status: 200,
        body: await apps.install(context, params.appId, body.version),
      };
    },
    uninstall: async ({ request, params, body }) => {
      const { apps, context } = use(request);

      return {
        status: 200,
        body: await apps.uninstall(context, params.appId, body.version),
      };
    },
  });
}
