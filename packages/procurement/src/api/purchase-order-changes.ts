import '@luma/identity/http';

import { apiContract } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { PurchaseOrderChanges } from '../application/purchase-order-changes.js';

/** Registers tenant-scoped revisions through the same policy-controlled path as submission. */
export function purchaseOrderChangeRoutes(service?: PurchaseOrderChanges) {
  const os = implement(apiContract.procurementChanges).$context<HttpContext>();

  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    if (!service)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Order changes are unavailable.',
      );

    return { service, context: request.tenantContext };
  }

  return os.router({
    list: os.list.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return s.service.list(s.context, params.purchaseOrderId);
      },
    ),
    propose: os.propose.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return s.service.propose(s.context, params.purchaseOrderId, body);
      },
    ),
    decide: os.decide.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return s.service.decide(s.context, params.changeId, body.outcome);
      },
    ),
    send: os.send.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return s.service.send(s.context, params.changeId);
      },
    ),
    check: os.check.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return s.service.check(s.context, params.changeId);
      },
    ),
  });
}
