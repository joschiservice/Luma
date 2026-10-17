import { apiContract } from '@luma/api-contract';
import { appRoutes } from '@luma/app-host/http';
import type { HttpContext } from '@luma/identity/http';
import { ServiceError, unavailable } from '@luma/platform';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { AppDependencies } from '../http-app.js';

/** Implements the routes `@luma/app-host` serves. Missing services answer as unavailable. */
export function appHostHttp(services: AppDependencies) {
  const os = implement(apiContract.stockProtection).$context<HttpContext>();
  const stockProtection = (request: FastifyRequest) => {
    if (!request.tenantContext)
      throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    const service = services.appRegistry?.stockProtection()[0];
    if (!service) throw unavailable('Stock protection is unavailable.');

    return { service, context: request.tenantContext };
  };

  return {
    apps: appRoutes(services.apps),
    stockProtection: os.router({
      view: os.view.handler(
        async ({ context: { request }, input: { body } }) => {
          const s = stockProtection(request);

          return s.service.view(s.context, body);
        },
      ),
      save: os.save.handler(
        async ({ context: { request }, input: { body } }) => {
          const s = stockProtection(request);

          return s.service.save(s.context, body);
        },
      ),
      control: os.control.handler(
        async ({ context: { request }, input: { body } }) => {
          const s = stockProtection(request);

          return s.service.control(s.context, body);
        },
      ),
    }),
  };
}
