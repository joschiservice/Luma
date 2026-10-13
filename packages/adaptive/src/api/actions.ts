import '@luma/identity/http';

import { apiContract } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { ViewActions } from '../application/actions.js';

/** Registers view buttons through the existing record owners' governed commands. */
export function viewActionRoutes(service?: ViewActions) {
  const os = implement(apiContract.adaptiveActions).$context<HttpContext>();

  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    if (!service)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'View actions are unavailable.',
      );

    return { service, context: request.tenantContext };
  }

  return os.router({
    definitions: os.definitions.handler(
      async ({ context: { request }, input: { query } }) => {
        const s = use(request);

        return s.service.definitions(s.context, query.domain);
      },
    ),
    catalog: os.catalog.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return s.service.catalog(s.context, params.viewId);
      },
    ),
    preview: os.preview.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return s.service.preview(
          s.context,
          params.viewId,
          params.actionId,
          body,
        );
      },
    ),
    run: os.run.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return s.service.run(s.context, params.viewId, params.actionId, body);
      },
    ),
  });
}
