import '@luma/identity/http';

import type { ServerResponse } from 'node:http';

import { apiContract } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { TraceContext } from '@luma/platform';
import { initServer } from '@ts-rest/fastify';
import type { FastifyRequest } from 'fastify';

import type {
  DraftGeneration,
  GenerationOptions,
} from '../application/draft-generation.js';

/** Aborts model work when the client disconnects before the response is sent. */
function requestOptions(
  request: FastifyRequest,
  reply: unknown,
): GenerationOptions {
  // ts-rest types the reply with other Fastify generics; `raw` is the Node response.
  const { raw } = reply as { raw: ServerResponse };
  const controller = new AbortController();
  raw.once('close', () => {
    if (!raw.writableFinished) controller.abort();
  });

  // The HTTP host attaches the tenant-scoped request trace; model calls become its children.
  const { observation } = request as FastifyRequest & {
    observation?: { context: TraceContext } | null;
  };

  return { signal: controller.signal, trace: observation?.context };
}

/** Registers tenant-authenticated routes for describing, refining and generating Code Steps. */
export function workflowGenerationRoutes(service?: DraftGeneration) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Workflow authoring is unavailable. Try again later.',
      );

    return { context: request.tenantContext, service };
  }

  return initServer().router(apiContract.workflowGeneration, {
    availability: async ({ request }) => {
      const s = use(request);

      return { status: 200, body: await s.service.availability(s.context) };
    },
    describe: async ({ request, reply, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.describe(
          s.context,
          body,
          requestOptions(request, reply),
        ),
      };
    },
    refine: async ({ request, reply, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.refine(
          s.context,
          params.draftId,
          body,
          requestOptions(request, reply),
        ),
      };
    },
    accept: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.accept(
          s.context,
          params.draftId,
          params.proposalId,
          body,
        ),
      };
    },
    reject: async ({ request, params }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.reject(
          s.context,
          params.draftId,
          params.proposalId,
        ),
      };
    },
    codeStep: async ({ request, reply, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.codeStep(
          s.context,
          params.draftId,
          body,
          requestOptions(request, reply),
        ),
      };
    },
    generations: async ({ request, params }) => {
      const s = use(request);

      return {
        status: 200,
        body: {
          items: await s.service.generations(s.context, params.draftId),
        },
      };
    },
  });
}
