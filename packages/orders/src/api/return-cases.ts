import '@luma/identity/http';

import { apiContract } from '@luma/api-contract';
import type { HttpContext } from '@luma/identity/http';
import { ServiceError, unavailable } from '@luma/platform';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { ReturnActions } from '../application/return-actions.js';
import type { ReturnCases } from '../application/return-cases.js';
import type { ReturnDeadlines } from '../application/return-deadlines.js';
import type { ReturnExchanges } from '../application/return-exchanges.js';

/** Registers tenant-authenticated return case reads and permission-gated changes. */
export function returnCaseRoutes(
  service?: ReturnCases,
  actions?: ReturnActions,
  exchanges?: ReturnExchanges,
  deadlines?: ReturnDeadlines,
) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service)
      throw unavailable('Return cases are unavailable. Try again later.');

    return { context: request.tenantContext, service };
  }

  const os = implement(apiContract.returnCases).$context<HttpContext>();

  function settlement(request: FastifyRequest) {
    const current = use(request);
    if (!actions) throw unavailable('Return settlement is unavailable');

    return { context: current.context, service: actions };
  }

  function exchange(request: FastifyRequest) {
    const current = use(request);
    if (!exchanges) throw unavailable('Exchange coordination unavailable');

    return { context: current.context, service: exchanges };
  }

  function waiting(request: FastifyRequest) {
    const current = use(request);
    if (!deadlines) throw unavailable('Return waiting is unavailable');

    return { context: current.context, service: deadlines };
  }

  return os.router({
    deadlines: os.deadlines.handler(({ context: { request } }) => {
      const s = waiting(request);

      return s.service.policy(s.context);
    }),
    configureDeadlines: os.configureDeadlines.handler(
      ({ context: { request }, input }) => {
        const s = waiting(request);

        return s.service.configure(s.context, input.body);
      },
    ),
    waiting: os.waiting.handler(({ context: { request }, input }) => {
      const s = waiting(request);

      return s.service.get(s.context, input.params.caseId);
    }),
    checkWaiting: os.checkWaiting.handler(({ context: { request }, input }) => {
      const s = waiting(request);

      return s.service.check(s.context, input.params.caseId);
    }),
    exchanges: os.exchanges.handler(({ context: { request }, input }) => {
      const s = exchange(request);

      return s.service.list(s.context, input.params.caseId);
    }),
    completeExchange: os.completeExchange.handler(
      ({ context: { request }, input }) => {
        const s = exchange(request);

        return s.service.complete(s.context, input.params.caseId);
      },
    ),
    requestExchange: os.requestExchange.handler(
      ({ context: { request }, input }) => {
        const s = exchange(request);

        return s.service.request(s.context, input.params.caseId, {
          id: input.body.id,
          operationId: input.body.operationId,
          kind: input.body.kind,
          ...(input.body.replacementId
            ? { replacementId: input.body.replacementId }
            : {}),
          ...(input.body.quantity ? { quantity: input.body.quantity } : {}),
        });
      },
    ),
    chooseExchange: os.chooseExchange.handler(
      ({ context: { request }, input }) => {
        const s = exchange(request);

        return s.service.choose(s.context, input.params.caseId, input.body);
      },
    ),
    refundExchange: os.refundExchange.handler(
      ({ context: { request }, input }) => {
        const s = exchange(request);

        return s.service.fallbackRefund(
          s.context,
          input.params.caseId,
          input.body.revision,
        );
      },
    ),
    decideExchange: os.decideExchange.handler(
      ({ context: { request }, input }) => {
        const s = exchange(request);

        return s.service.decide(
          s.context,
          input.params.caseId,
          input.params.actionId,
          input.body,
        );
      },
    ),
    sendExchange: os.sendExchange.handler(({ context: { request }, input }) => {
      const s = exchange(request);

      return s.service.send(
        s.context,
        input.params.caseId,
        input.params.actionId,
      );
    }),
    checkExchange: os.checkExchange.handler(
      ({ context: { request }, input }) => {
        const s = exchange(request);

        return s.service.check(
          s.context,
          input.params.caseId,
          input.params.actionId,
        );
      },
    ),
    actions: os.actions.handler(({ context: { request }, input }) => {
      const s = settlement(request);

      return s.service.list(s.context, input.params.caseId);
    }),
    requestAction: os.requestAction.handler(
      ({ context: { request }, input }) => {
        const s = settlement(request);

        return s.service.request(s.context, input.params.caseId, {
          id: input.body.id,
          kind: input.body.kind,
          ...(input.body.targetId ? { targetId: input.body.targetId } : {}),
        });
      },
    ),
    decideAction: os.decideAction.handler(({ context: { request }, input }) => {
      const s = settlement(request);

      return s.service.decide(
        s.context,
        input.params.caseId,
        input.params.actionId,
        input.body,
      );
    }),
    sendAction: os.sendAction.handler(({ context: { request }, input }) => {
      const s = settlement(request);

      return s.service.send(
        s.context,
        input.params.caseId,
        input.params.actionId,
      );
    }),
    checkAction: os.checkAction.handler(({ context: { request }, input }) => {
      const s = settlement(request);

      return s.service.check(
        s.context,
        input.params.caseId,
        input.params.actionId,
      );
    }),
    list: os.list.handler(({ context: { request }, input }) => {
      const s = use(request);

      return s.service.list(s.context, {
        q: input.query.q,
        limit: input.query.limit,
        ...(input.query.customerId
          ? { customerId: input.query.customerId }
          : {}),
        ...(input.query.openOnly !== undefined
          ? { openOnly: input.query.openOnly }
          : {}),
        ...(input.query.cursor ? { cursor: input.query.cursor } : {}),
      });
    }),
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
