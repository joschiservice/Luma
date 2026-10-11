import '@luma/identity/http';

import { apiContract } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { ReturnCases } from '../application/return-cases.js';

/** Registers tenant-authenticated return case reads and permission-gated changes. */
export function returnCaseRoutes(service?: ReturnCases) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Return cases are unavailable. Try again later.',
      );

    return { context: request.tenantContext, service };
  }

  const os = implement(apiContract.returnCases).$context<HttpContext>();

  return os.router({
    forOrder: os.forOrder.handler(({ context: { request }, input }) => {
      const s = use(request);

      return s.service.forOrder(s.context, input.params.orderId);
    }),
    open: os.open.handler(({ context: { request }, input }) => {
      const s = use(request);

      return s.service.open(s.context, input.params.orderId, input.body);
    }),
    get: os.get.handler(({ context: { request }, input }) => {
      const s = use(request);

      return s.service.get(s.context, input.params.caseId);
    }),
    assign: os.assign.handler(({ context: { request }, input }) => {
      const s = use(request);

      return s.service.assign(s.context, input.params.caseId, input.body);
    }),
    recordReceipt: os.recordReceipt.handler(
      ({ context: { request }, input }) => {
        const s = use(request);

        return s.service.recordReceipt(
          s.context,
          input.params.caseId,
          input.body,
        );
      },
    ),
    recordInspection: os.recordInspection.handler(
      ({ context: { request }, input }) => {
        const s = use(request);

        return s.service.recordInspection(
          s.context,
          input.params.caseId,
          input.body,
        );
      },
    ),
    proposeResolution: os.proposeResolution.handler(
      ({ context: { request }, input }) => {
        const s = use(request);

        return s.service.proposeResolution(
          s.context,
          input.params.caseId,
          input.body,
        );
      },
    ),
    cancel: os.cancel.handler(({ context: { request }, input }) => {
      const s = use(request);

      return s.service.cancel(s.context, input.params.caseId, input.body);
    }),
    creationOptions: os.creationOptions.handler(
      ({ context: { request }, input }) => {
        const s = use(request);

        return s.service.creationOptions(s.context, input.params.caseId);
      },
    ),
    requestCreation: os.requestCreation.handler(
      ({ context: { request }, input }) => {
        const s = use(request);

        return s.service.requestCreation(
          s.context,
          input.params.caseId,
          input.body,
        );
      },
    ),
    decideCreation: os.decideCreation.handler(
      ({ context: { request }, input }) => {
        const s = use(request);

        return s.service.decideCreation(
          s.context,
          input.params.caseId,
          input.params.creationId,
          input.body,
        );
      },
    ),
    sendCreation: os.sendCreation.handler(({ context: { request }, input }) => {
      const s = use(request);

      return s.service.sendCreation(
        s.context,
        input.params.caseId,
        input.params.creationId,
      );
    }),
    checkCreation: os.checkCreation.handler(
      ({ context: { request }, input }) => {
        const s = use(request);

        return s.service.checkCreation(
          s.context,
          input.params.caseId,
          input.params.creationId,
        );
      },
    ),
  });
}
