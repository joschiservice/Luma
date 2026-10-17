import '@luma/identity/http';

import {
  apiContract,
  learningEventSchema,
  resolutionHistorySchema,
  resolutionRunSchema,
} from '@luma/api-contract';
import type { HttpContext } from '@luma/identity/http';
import { ServiceError, unavailable } from '@luma/platform';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { LearningService } from '../application/learning.js';

/**
 * Creates authenticated handlers for recording and reading resolution runs and learning
 * events.
 */
export function learningRoutes(service?: LearningService) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service) throw unavailable('Resolution history is unavailable');

    return { context: request.tenantContext, service };
  }

  const os = implement(apiContract.resolutionLearning).$context<HttpContext>();

  return os.router({
    list: os.list.handler(
      async ({ context: { request }, input: { params, query } }) => {
        const s = use(request);
        const page = await s.service.list(
          s.context,
          params.exceptionId,
          query.after,
        );

        return {
          ...page,
          items: page.items.map((item) => resolutionRunSchema.parse(item)),
        };
      },
    ),
    start: os.start.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return resolutionRunSchema.parse(
          await s.service.start(s.context, params.exceptionId, body),
        );
      },
    ),
    append: os.append.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return learningEventSchema.parse(
          await s.service.append(
            s.context,
            params.exceptionId,
            params.runId,
            body,
          ),
        );
      },
    ),
    read: os.read.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return resolutionHistorySchema.parse(
          await s.service.read(s.context, params.exceptionId, params.runId),
        );
      },
    ),
  });
}
