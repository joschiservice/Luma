import '@luma/identity/http';

import { apiContract } from '@luma/api-contract';
import type { HttpContext } from '@luma/identity/http';
import type { TraceContext } from '@luma/platform';
import { ServiceError, unavailable } from '@luma/platform';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type {
  DraftGeneration,
  GenerationOptions,
} from '../application/draft-generation.js';

/**
 * Passes the request signal, which aborts model work when the client disconnects before the
 * response is sent, and the request trace.
 */
function requestOptions(
  request: FastifyRequest,
  signal: AbortSignal | undefined,
): GenerationOptions {
  // The HTTP host attaches the tenant-scoped request trace; model calls become its children.
  const { observation } = request as FastifyRequest & {
    observation?: { context: TraceContext } | null;
  };

  return { signal, trace: observation?.context };
}

/** Registers tenant-authenticated routes for describing, refining and generating Code Steps. */
export function workflowGenerationRoutes(service?: DraftGeneration) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service)
      throw unavailable('Workflow authoring is unavailable. Try again later.');

    return { context: request.tenantContext, service };
  }

  const os = implement(apiContract.workflowGeneration).$context<HttpContext>();

  return os.router({
    discover: os.discover.handler(async ({ context: { request } }) => {
      const s = use(request);

      return await s.service.discover(s.context);
    }),
    availability: os.availability.handler(async ({ context: { request } }) => {
      const s = use(request);

      return await s.service.availability(s.context);
    }),
    describe: os.describe.handler(
      async ({ context: { request }, input: { body }, signal }) => {
        const s = use(request);

        return await s.service.describe(
          s.context,
          body,
          requestOptions(request, signal),
        );
      },
    ),
    refine: os.refine.handler(
      async ({ context: { request }, input: { params, body }, signal }) => {
        const s = use(request);

        return await s.service.refine(
          s.context,
          params.draftId,
          body,
          requestOptions(request, signal),
        );
      },
    ),
    accept: os.accept.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.service.accept(
          s.context,
          params.draftId,
          params.proposalId,
          body,
        );
      },
    ),
    reject: os.reject.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.service.reject(
          s.context,
          params.draftId,
          params.proposalId,
        );
      },
    ),
    codeStep: os.codeStep.handler(
      async ({ context: { request }, input: { params, body }, signal }) => {
        const s = use(request);

        return await s.service.codeStep(
          s.context,
          params.draftId,
          body,
          requestOptions(request, signal),
        );
      },
    ),
    generations: os.generations.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return {
          items: await s.service.generations(s.context, params.draftId),
        };
      },
    ),
  });
}
