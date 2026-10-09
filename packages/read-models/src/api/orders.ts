import '@luma/identity/http';

import {
  apiContract,
  orderDetailSchema,
  orderListSchema,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';

import type { OrderWorkspace } from '../application/orders.js';

/** Exposes the tenant's order list and order details to readers with `orders.read`. */
export function orderRoutes(service?: OrderWorkspace) {
  const os = implement(apiContract.orders).$context<HttpContext>();

  return os.router({
    list: os.list.handler(
      async ({ context: { request }, input: { query } }) => {
        if (!request.tenantContext)
          throw new IdentityError(
            401,
            'UNAUTHENTICATED',
            'Sign in to continue',
          );
        if (!service)
          throw new IdentityError(
            503,
            'SERVICE_UNAVAILABLE',
            'Orders are unavailable',
          );

        return orderListSchema.parse(
          await service.list(request.tenantContext, query),
        );
      },
    ),
    get: os.get.handler(async ({ context: { request }, input: { params } }) => {
      if (!request.tenantContext)
        throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (!service)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Order details are unavailable',
        );
      const detail = await service.get(request.tenantContext, params.orderId);
      if (!detail) throw new IdentityError(404, 'NOT_FOUND', 'Order not found');

      return orderDetailSchema.parse(detail);
    }),
  });
}
