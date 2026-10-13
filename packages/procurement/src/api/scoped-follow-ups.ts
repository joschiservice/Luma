import '@luma/identity/http';

import { apiContract } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { GovernedFollowUps } from '../application/governed-follow-up.js';

/** Registers owner-scoped internal note reviews, responses and explicit stale renewal. */
export function scopedFollowUpRoutes(service?: GovernedFollowUps) {
  const use = (request: FastifyRequest) => {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    if (!service)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Governed supplier follow-ups are unavailable.',
      );

    return { context: request.tenantContext, service };
  };
  const os = implement(apiContract.scopedFollowUps).$context<HttpContext>();

  return os.router({
    list: os.list.handler(async ({ context: { request } }) => {
      const s = use(request);

      return { items: await s.service.pending(s.context) };
    }),
    respond: os.respond.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return s.service.respond(
          s.context,
          params.proposalId,
          body.decisionId,
          body.outcome,
        );
      },
    ),
    reconcile: os.reconcile.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return s.service.reconcile(s.context, params.proposalId);
      },
    ),
    refresh: os.refresh.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return s.service.refresh(s.context, params.proposalId, body.commandId);
      },
    ),
  });
}
