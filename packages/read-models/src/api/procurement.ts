import '@luma/identity/http';

import { apiContract } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { ProcurementContextReader } from '../application/procurement.js';

/** Exposes stock, product, issue and replenishment context for purchase orders and suppliers. */
export function procurementContextRoutes(reader?: ProcurementContextReader) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!reader)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Procurement context is unavailable',
      );

    return { context: request.tenantContext, reader };
  }

  const os = implement(apiContract.procurementContext).$context<HttpContext>();

  return os.router({
    order: os.order.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);
        const result = await s.reader.order(s.context, params.purchaseOrderId);
        if (!result)
          throw new IdentityError(404, 'NOT_FOUND', 'Purchase order not found');

        return result;
      },
    ),
    supplier: os.supplier.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);
        const result = await s.reader.supplier(s.context, params.supplierId);
        if (!result)
          throw new IdentityError(404, 'NOT_FOUND', 'Supplier not found');

        return result;
      },
    ),
  });
}
