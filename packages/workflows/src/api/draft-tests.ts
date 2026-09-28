import '@luma/identity/http';

import { apiContract } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import { initServer } from '@ts-rest/fastify';
import type { FastifyRequest } from 'fastify';

import type { DraftTests } from '../application/draft-tests.js';

/** Registers tenant-authenticated routes for saved test cases and draft test runs. */
export function draftTestRoutes(service?: DraftTests) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Draft tests are unavailable. Try again later.',
      );

    return { context: request.tenantContext, service };
  }

  return initServer().router(apiContract.draftTests, {
    list: async ({ request, params }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.cases(s.context, params.draftId),
      };
    },
    save: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.saveCases(s.context, params.draftId, body),
      };
    },
    runAll: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.runAll(s.context, params.draftId, body),
      };
    },
    examples: async ({ request, params }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.examples(s.context, params.draftId),
      };
    },
    start: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.start(s.context, params.draftId, body),
      };
    },
    get: async ({ request, params }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.get(s.context, params.draftId, params.runId),
      };
    },
    cancel: async ({ request, params }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.cancel(s.context, params.draftId, params.runId),
      };
    },
  });
}
