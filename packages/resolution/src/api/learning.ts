import '@luma/identity/http';

import {
  apiContract,
  learningEventSchema,
  resolutionHistorySchema,
  resolutionRunSchema,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import { initServer } from '@ts-rest/fastify';
import type { FastifyRequest } from 'fastify';

import type { LearningService } from '../application/learning.js';

/**
 * Creates authenticated handlers for recording and reading resolution runs and learning
 * events.
 */
export function learningRoutes(service?: LearningService) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Resolution history is unavailable',
      );

    return { context: request.tenantContext, service };
  }

  return initServer().router(apiContract.resolutionLearning, {
    list: async ({ request, params, query }) => {
      const s = use(request);
      const page = await s.service.list(
        s.context,
        params.exceptionId,
        query.after,
      );

      return {
        status: 200,
        body: {
          ...page,
          items: page.items.map((item) => resolutionRunSchema.parse(item)),
        },
      };
    },
    start: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: resolutionRunSchema.parse(
          await s.service.start(s.context, params.exceptionId, body),
        ),
      };
    },
    append: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: learningEventSchema.parse(
          await s.service.append(
            s.context,
            params.exceptionId,
            params.runId,
            body,
          ),
        ),
      };
    },
    read: async ({ request, params }) => {
      const s = use(request);

      return {
        status: 200,
        body: resolutionHistorySchema.parse(
          await s.service.read(s.context, params.exceptionId, params.runId),
        ),
      };
    },
  });
}
