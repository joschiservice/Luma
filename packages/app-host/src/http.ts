import '@luma/identity/http';

import { apiContract } from '@luma/api-contract';
import type { HttpContext } from '@luma/identity/http';
import { ServiceError, unavailable } from '@luma/platform';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { AppService } from './index.js';

/** Exposes tenant-authorized app catalog and installation commands. */
export function appRoutes(apps?: AppService) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!apps) throw unavailable('App management is unavailable');

    return { apps, context: request.tenantContext };
  }

  const os = implement(apiContract.apps).$context<HttpContext>();

  return os.router({
    list: os.list.handler(async ({ context: { request } }) => {
      const { apps, context } = use(request);

      return await apps.list(context);
    }),
    install: os.install.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const { apps, context } = use(request);

        return await apps.install(
          context,
          params.appId,
          body.version,
          body.scopes,
        );
      },
    ),
    approveScopes: os.approveScopes.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const { apps, context } = use(request);

        return await apps.approveScopes(
          context,
          params.appId,
          body.version,
          body.scopes,
        );
      },
    ),
    uninstall: os.uninstall.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const { apps, context } = use(request);

        return await apps.uninstall(context, params.appId, body.version);
      },
    ),
  });
}
