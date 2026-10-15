import '@luma/identity/http';

import {
  apiContract,
  decisionAssignResultSchema,
  decisionListSchema,
  decisionsCatalog,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';

import type {
  DecisionAssignments,
  DecisionQueue,
} from '../application/decisions.js';
import { validateCollectionQuery } from './collection-validation.js';

/**
 * Exposes the Needs you queue, filtered by the reader's permissions, and assignment changes to
 * its owner. Conditions and grouping are checked against the decisions catalog first.
 */
export function decisionRoutes(
  queue?: DecisionQueue,
  assignments?: DecisionAssignments,
) {
  const os = implement(apiContract.decisions).$context<HttpContext>();

  return os.router({
    get: os.get.handler(async ({ context: { request }, input: { params } }) => {
      if (!request.tenantContext)
        throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (!queue)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Needs you is unavailable',
        );

      return queue.find(request.tenantContext, params.decisionId);
    }),
    list: os.list.handler(
      async ({ context: { request }, input: { query } }) => {
        if (!request.tenantContext)
          throw new IdentityError(
            401,
            'UNAUTHENTICATED',
            'Sign in to continue',
          );
        if (!queue)
          throw new IdentityError(
            503,
            'SERVICE_UNAVAILABLE',
            'Needs you is unavailable',
          );

        validateCollectionQuery(decisionsCatalog, query);

        return decisionListSchema.parse(
          await queue.list(request.tenantContext, query),
        );
      },
    ),
    assign: os.assign.handler(
      async ({ context: { request }, input: { body } }) => {
        if (!request.tenantContext)
          throw new IdentityError(
            401,
            'UNAUTHENTICATED',
            'Sign in to continue',
          );
        if (!assignments)
          throw new IdentityError(
            503,
            'SERVICE_UNAVAILABLE',
            'Assignments are unavailable',
          );

        return decisionAssignResultSchema.parse(
          await assignments.assign(request.tenantContext, body),
        );
      },
    ),
  });
}
