import '@luma/identity/http';

import { apiContract, assistantAnswerSchema } from '@luma/api-contract';
import type { HttpContext } from '@luma/identity/http';
import type { TraceContext } from '@luma/platform';
import { ServiceError, unavailable } from '@luma/platform';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { AskOptions, Assistant } from '../application/assistant.js';

/**
 * Passes the request signal, which aborts model and read work when the client disconnects
 * before the response is sent, and the request trace.
 */
function requestOptions(
  request: FastifyRequest,
  signal: AbortSignal | undefined,
): AskOptions {
  // The HTTP host attaches the tenant-scoped request trace; assistant spans become its children.
  const { observation } = request as FastifyRequest & {
    observation?: { context: TraceContext } | null;
  };

  return { signal, trace: observation?.context };
}

/** Registers tenant-authenticated routes for asking the workspace assistant. */
export function assistantRoutes(service?: Assistant) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service)
      throw unavailable('Asking Luma is unavailable. Try again later.');

    return { context: request.tenantContext, service };
  }

  const os = implement(apiContract.assistant).$context<HttpContext>();

  return os.router({
    availability: os.availability.handler(async ({ context: { request } }) => {
      const s = use(request);

      return await s.service.availability(s.context);
    }),
    ask: os.ask.handler(
      async ({ context: { request }, input: { body }, signal }) => {
        const s = use(request);

        return assistantAnswerSchema.parse(
          await s.service.ask(s.context, body, requestOptions(request, signal)),
        );
      },
    ),
  });
}
