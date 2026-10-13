import '@luma/identity/http';

import { apiContract } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { OperationalPackages } from '../application/packages.js';

/** Registers reviewed installs and removals of operational definitions. */
export function operationalPackageRoutes(service?: OperationalPackages) {
  const os = implement(apiContract.adaptivePackages).$context<HttpContext>();

  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    if (!service)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Operational packages are unavailable.',
      );

    return { service, context: request.tenantContext };
  }

  return os.router({
    list: os.list.handler(async ({ context: { request } }) => {
      const s = use(request);

      return s.service.list(s.context);
    }),
    preview: os.preview.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return s.service.preview(s.context, params.packageId, body);
      },
    ),
    install: os.install.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return s.service.install(s.context, params.packageId, body);
      },
    ),
    uninstall: os.uninstall.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return s.service.uninstall(s.context, params.packageId, body);
      },
    ),
  });
}
