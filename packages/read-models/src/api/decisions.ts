import '@luma/identity/http';

import {
  apiContract,
  decisionAssignResultSchema,
  decisionListSchema,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import { initServer } from '@ts-rest/fastify';

import type {
  DecisionAssignments,
  DecisionQueue,
} from '../application/decisions.js';

/** Exposes the Needs you queue, filtered by the reader's permissions, and assignment changes to its owner. */
export function decisionRoutes(
  queue?: DecisionQueue,
  assignments?: DecisionAssignments,
) {
  return initServer().router(apiContract.decisions, {
    list: async ({ request, query }) => {
      if (!request.tenantContext)
        throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (!queue)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Needs you is unavailable',
        );

      return {
        status: 200,
        body: decisionListSchema.parse(
          await queue.list(request.tenantContext, query),
        ),
      };
    },
    assign: async ({ request, body }) => {
      if (!request.tenantContext)
        throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (!assignments)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Assignments are unavailable',
        );

      return {
        status: 200,
        body: decisionAssignResultSchema.parse(
          await assignments.assign(request.tenantContext, body),
        ),
      };
    },
  });
}
