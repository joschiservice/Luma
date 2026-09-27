import '@luma/identity/http';

import { apiContract } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import { initServer } from '@ts-rest/fastify';
import type { FastifyRequest } from 'fastify';

import type { ProcurementService } from '../application/procurement.js';

/** Registers tenant-authenticated procurement reads and administrator writes. */
export function procurementRoutes(service?: ProcurementService) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Procurement is unavailable. Try again later.',
      );

    return { context: request.tenantContext, service };
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
