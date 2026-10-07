import '@luma/identity/http';

import { apiContract } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import { initServer } from '@ts-rest/fastify';
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

  return initServer().router(apiContract.procurement, {
    suppliers: async ({ request }) => {
      const s = use(request);

      return { status: 200, body: await s.service.suppliers(s.context) };
    },
    orders: async ({ request }) => {
      const s = use(request);

      return { status: 200, body: await s.service.orders(s.context) };
    },
    createSupplier: async ({ request, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.createSupplier(s.context, body),
      };
    },
    createOrder: async ({ request, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.createOrder(s.context, body),
      };
    },
    detail: async ({ request, params }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.detail(s.context, params.purchaseOrderId),
      };
    },
    supplier: async ({ request, params }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.commitments.supplier(s.context, params.supplierId),
      };
    },
    linkSupplier: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.commitments.linkSupplier(
          s.context,
          params.supplierId,
          body,
        ),
      };
    },
    purchasingConnections: async ({ request }) => {
      const s = use(request);

      return { status: 200, body: await s.commitments.connections(s.context) };
    },
    purchasingSuppliers: async ({ request, params, query }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.commitments.purchasingSuppliers(
          s.context,
          params.connectionId,
          query.cursor,
        ),
      };
    },
    progress: async ({ request }) => {
      const s = use(request);

      return {
        status: 200,
        body: { items: await s.commitments.summaries(s.context) },
      };
    },
    record: async ({ request, params }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.commitments.order(s.context, params.purchaseOrderId),
      };
    },
    refresh: async ({ request, params }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.commitments.refresh(s.context, params.purchaseOrderId),
      };
    },
    requestSubmission: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.commitments.requestSubmission(
          s.context,
          params.purchaseOrderId,
          body,
        ),
      };
    },
    decideSubmission: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.commitments.decideSubmission(
          s.context,
          params.submissionId,
          body,
        ),
      };
    },
    sendSubmission: async ({ request, params }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.commitments.sendSubmission(
          s.context,
          params.submissionId,
        ),
      };
    },
    checkSubmission: async ({ request, params }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.commitments.checkSubmission(
          s.context,
          params.submissionId,
        ),
      };
    },
    recordMessage: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.commitments.recordMessage(
          s.context,
          params.purchaseOrderId,
          body,
        ),
      };
    },
    readMessage: async ({ request, params }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.commitments.extractAgain(
          s.context,
          params.communicationId,
        ),
      };
    },
    removeMessageText: async ({ request, params }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.commitments.removeMessageText(
          s.context,
          params.communicationId,
        ),
      };
    },
    recordCommitment: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.commitments.recordCommitment(
          s.context,
          params.purchaseOrderId,
          body,
        ),
      };
    },
    reviewCommitment: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.commitments.reviewCommitment(
          s.context,
          params.commitmentId,
          body,
        ),
      };
    },
    respond: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.commitments.respond(
          s.context,
          params.purchaseOrderId,
          body,
        ),
      };
    },
    transition: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.transition(
          s.context,
          params.purchaseOrderId,
          body,
        ),
      };
    },
  });
}
