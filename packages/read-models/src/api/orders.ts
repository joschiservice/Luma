import '@luma/identity/http';

import {
  apiContract,
  type OrderChangePlanQuery,
  orderChangePlansSchema,
  orderDetailSchema,
  orderListSchema,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import type { OrderChangeRequest } from '@luma/orders';
import { implement } from '@orpc/server';

import type { OrderWorkspace } from '../application/orders.js';

/** Converts validated plan parameters to a change request; null plans detected differences. */
function changeRequest(query: OrderChangePlanQuery): OrderChangeRequest | null {
  const { kind, lineKey, quantity } = query;
  if (!kind) return null;
  if (kind === 'location') return { kind, lineKey: lineKey ?? null };
  if (kind === 'cancellation' || kind === 'address') return { kind };
  if (!lineKey || (kind === 'quantity' && quantity === undefined))
    throw new IdentityError(
      422,
      'VALIDATION_ERROR',
      'Choose a line and quantity.',
    );

  return kind === 'item'
    ? { kind, lineKey }
    : { kind, lineKey, quantity: quantity ?? '' };
}

/** Exposes the tenant's order list, order details and change plans to readers with `orders.read`. */
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
    changePlan: os.changePlan.handler(
      async ({ context: { request }, input: { params, query } }) => {
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
            'Order plans are unavailable',
          );
        const plans = await service.changePlan(
          request.tenantContext,
          params.orderId,
          changeRequest(query),
        );
        if (!plans)
          throw new IdentityError(404, 'NOT_FOUND', 'Order not found');

        return orderChangePlansSchema.parse(plans);
      },
    ),
  });
}
