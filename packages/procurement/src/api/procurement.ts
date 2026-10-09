import '@luma/identity/http';

import { apiContract } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { SupplierCommitments } from '../application/commitments.js';
import type { ProcurementService } from '../application/procurement.js';

/** Registers tenant-authenticated procurement reads and permission-gated writes. */
export function procurementRoutes(
  service?: ProcurementService,
  commitments?: SupplierCommitments,
) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service || !commitments)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Procurement is unavailable. Try again later.',
      );

    return { context: request.tenantContext, service, commitments };
  }

  const os = implement(apiContract.procurement).$context<HttpContext>();

  return os.router({
    suppliers: os.suppliers.handler(async ({ context: { request } }) => {
      const s = use(request);

      return await s.service.suppliers(s.context);
    }),
    orders: os.orders.handler(async ({ context: { request } }) => {
      const s = use(request);

      return await s.service.orders(s.context);
    }),
    createSupplier: os.createSupplier.handler(
      async ({ context: { request }, input: { body } }) => {
        const s = use(request);

        return await s.service.createSupplier(s.context, body);
      },
    ),
    createOrder: os.createOrder.handler(
      async ({ context: { request }, input: { body } }) => {
        const s = use(request);

        return await s.service.createOrder(s.context, body);
      },
    ),
    detail: os.detail.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.service.detail(s.context, params.purchaseOrderId);
      },
    ),
    supplier: os.supplier.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.commitments.supplier(s.context, params.supplierId);
      },
    ),
    linkSupplier: os.linkSupplier.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.commitments.linkSupplier(
          s.context,
          params.supplierId,
          body,
        );
      },
    ),
    purchasingConnections: os.purchasingConnections.handler(
      async ({ context: { request } }) => {
        const s = use(request);

        return await s.commitments.connections(s.context);
      },
    ),
    purchasingSuppliers: os.purchasingSuppliers.handler(
      async ({ context: { request }, input: { params, query } }) => {
        const s = use(request);

        return await s.commitments.purchasingSuppliers(
          s.context,
          params.connectionId,
          query.cursor,
        );
      },
    ),
    progress: os.progress.handler(async ({ context: { request } }) => {
      const s = use(request);

      return { items: await s.commitments.summaries(s.context) };
    }),
    record: os.record.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.commitments.order(s.context, params.purchaseOrderId);
      },
    ),
    refresh: os.refresh.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.commitments.refresh(s.context, params.purchaseOrderId);
      },
    ),
    requestSubmission: os.requestSubmission.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.commitments.requestSubmission(
          s.context,
          params.purchaseOrderId,
          body,
        );
      },
    ),
    decideSubmission: os.decideSubmission.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.commitments.decideSubmission(
          s.context,
          params.submissionId,
          body,
        );
      },
    ),
    sendSubmission: os.sendSubmission.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.commitments.sendSubmission(
          s.context,
          params.submissionId,
        );
      },
    ),
    checkSubmission: os.checkSubmission.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.commitments.checkSubmission(
          s.context,
          params.submissionId,
        );
      },
    ),
    recordMessage: os.recordMessage.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.commitments.recordMessage(
          s.context,
          params.purchaseOrderId,
          body,
        );
      },
    ),
    readMessage: os.readMessage.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.commitments.extractAgain(
          s.context,
          params.communicationId,
        );
      },
    ),
    removeMessageText: os.removeMessageText.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.commitments.removeMessageText(
          s.context,
          params.communicationId,
        );
      },
    ),
    recordCommitment: os.recordCommitment.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.commitments.recordCommitment(
          s.context,
          params.purchaseOrderId,
          body,
        );
      },
    ),
    reviewCommitment: os.reviewCommitment.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.commitments.reviewCommitment(
          s.context,
          params.commitmentId,
          body,
        );
      },
    ),
    respond: os.respond.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.commitments.respond(
          s.context,
          params.purchaseOrderId,
          body,
        );
      },
    ),
    transition: os.transition.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.service.transition(
          s.context,
          params.purchaseOrderId,
          body,
        );
      },
    ),
  });
}
