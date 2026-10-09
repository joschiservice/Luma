import '@luma/identity/http';

import { apiContract } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';
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

  const os = implement(apiContract.draftTests).$context<HttpContext>();

  return os.router({
    list: os.list.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.service.cases(s.context, params.draftId);
      },
    ),
    save: os.save.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.service.saveCases(s.context, params.draftId, body);
      },
    ),
    runAll: os.runAll.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.service.runAll(s.context, params.draftId, body);
      },
    ),
    examples: os.examples.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.service.examples(s.context, params.draftId);
      },
    ),
    start: os.start.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.service.start(s.context, params.draftId, body);
      },
    ),
    get: os.get.handler(async ({ context: { request }, input: { params } }) => {
      const s = use(request);

      return await s.service.get(s.context, params.draftId, params.runId);
    }),
    cancel: os.cancel.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.service.cancel(s.context, params.draftId, params.runId);
      },
    ),
  });
}
