import '@luma/identity/http';

import {
  apiContract,
  orderDetailSchema,
  orderListSchema,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import { initServer } from '@ts-rest/fastify';

import type { OrderWorkspace } from '../application/orders.js';

/** Exposes the tenant's order list and order details to workspace members. */
export function orderRoutes(service?: OrderWorkspace) {
  return initServer().router(apiContract.orders, {
    list: async ({ request, query }) => {
      if (!request.tenantContext)
        throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (!service)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Orders are unavailable',
        );

      return {
        status: 200,
        body: orderListSchema.parse(
          await service.list(request.tenantContext, query),
        ),
      };
    },
    get: async ({ request, params }) => {
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

      return { status: 200, body: orderDetailSchema.parse(detail) };
    },
  });
}
