import '@luma/identity/http';

import {
  apiContract,
  collectionGroupIssue,
  collectionWhereIssues,
  type OrderChangePlanQuery,
  orderChangePlansSchema,
  orderDetailSchema,
  type OrderListQuery,
  orderListSchema,
  ordersCatalog,
} from '@luma/api-contract';
import type { HttpContext } from '@luma/identity/http';
import type { OrderChangeRequest } from '@luma/orders';
import { invalid, notFound, ServiceError, unavailable } from '@luma/platform';
import { implement } from '@orpc/server';

import type { OrderWorkspace } from '../application/orders.js';

/** Converts validated plan parameters to a change request; null plans detected differences. */
function changeRequest(query: OrderChangePlanQuery): OrderChangeRequest | null {
  const { kind, lineKey, quantity } = query;
  if (!kind) return null;
  if (kind === 'location') return { kind, lineKey: lineKey ?? null };
  if (kind === 'cancellation' || kind === 'address') return { kind };
  if (!lineKey || (kind === 'quantity' && quantity === undefined))
    throw invalid('Choose a line and quantity.');

  return kind === 'item'
    ? { kind, lineKey }
    : { kind, lineKey, quantity: quantity ?? '' };
}

/**
 * Checks conditions and grouping against the Orders catalog. Throws a 400 error naming the
 * first invalid condition. Field permissions are checked by the workspace, which answers 403.
 */
export function validateOrderListQuery(query: OrderListQuery) {
  // Custom fields are checked against the workspace's live definitions when the list reads.
  const native = query.where?.conditions
    .map((condition, index) => ({ condition, index }))
    .filter(({ condition }) => !condition.field.startsWith('custom:'));
  const found = native?.length
    ? collectionWhereIssues(ordersCatalog, {
        match: query.where?.match ?? 'all',
        conditions: native.map(({ condition }) => condition),
      })[0]
    : undefined;
  const issue = found && {
    ...found,
    index: found.index === null ? null : (native?.[found.index]?.index ?? null),
  };
  const message = issue
    ? `Condition ${(issue.index ?? 0) + 1}: ${issue.message}.`
    : query.group
      ? collectionGroupIssue(
          ordersCatalog,
          query.group.field,
          query.group.granularity,
        )
      : query.groupKey !== undefined
        ? 'Choose a grouping to read one group'
        : null;
  if (message)
    throw Object.assign(
      new Error(message.endsWith('.') ? message : `${message}.`),
      { statusCode: 400, expose: true },
    );
}

/** Exposes the tenant's order list, order details and change plans to readers with `orders.read`. */
export function orderRoutes(service?: OrderWorkspace) {
  const os = implement(apiContract.orders).$context<HttpContext>();

  return os.router({
    list: os.list.handler(
      async ({ context: { request }, input: { query } }) => {
        if (!request.tenantContext)
          throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
        if (!service) throw unavailable('Orders are unavailable');

        validateOrderListQuery(query);

        return orderListSchema.parse(
          await service.list(request.tenantContext, query),
        );
      },
    ),
    get: os.get.handler(async ({ context: { request }, input: { params } }) => {
      if (!request.tenantContext)
        throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (!service) throw unavailable('Order details are unavailable');
      const detail = await service.get(request.tenantContext, params.orderId);
      if (!detail) throw notFound('Order not found');

      return orderDetailSchema.parse(detail);
    }),
    changePlan: os.changePlan.handler(
      async ({ context: { request }, input: { params, query } }) => {
        if (!request.tenantContext)
          throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
        if (!service) throw unavailable('Order plans are unavailable');
        const plans = await service.changePlan(
          request.tenantContext,
          params.orderId,
          changeRequest(query),
        );
        if (!plans) throw notFound('Order not found');

        return orderChangePlansSchema.parse(plans);
      },
    ),
  });
}
