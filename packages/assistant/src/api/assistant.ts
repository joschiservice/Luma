import '@luma/identity/http';

import type { ServerResponse } from 'node:http';

import { apiContract, assistantAnswerSchema } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { TraceContext } from '@luma/platform';
import { initServer } from '@ts-rest/fastify';
import type { FastifyRequest } from 'fastify';

import type { AskOptions, Assistant } from '../application/assistant.js';

/** Aborts model and read work when the client disconnects before the response is sent. */
function requestOptions(request: FastifyRequest, reply: unknown): AskOptions {
  // ts-rest types the reply with other Fastify generics; `raw` is the Node response.
  const { raw } = reply as { raw: ServerResponse };
  const controller = new AbortController();
  raw.once('close', () => {
    if (!raw.writableFinished) controller.abort();
  });

  // The HTTP host attaches the tenant-scoped request trace; assistant spans become its children.
  const { observation } = request as FastifyRequest & {
    observation?: { context: TraceContext } | null;
  };

  return { signal: controller.signal, trace: observation?.context };
}

/** Registers tenant-authenticated routes for asking the workspace assistant. */
export function assistantRoutes(service?: Assistant) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Asking Luma is unavailable. Try again later.',
      );

    return { context: request.tenantContext, service };
  }

  return initServer().router(apiContract.assistant, {
    availability: async ({ request }) => {
      const s = use(request);

      return { status: 200, body: await s.service.availability(s.context) };
    },
    ask: async ({ request, reply, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: assistantAnswerSchema.parse(
          await s.service.ask(s.context, body, requestOptions(request, reply)),
        ),
      };
    },
  });
}
