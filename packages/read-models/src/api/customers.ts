import '@luma/identity/http';

import {
  apiContract,
  customerDetailSchema,
  customerListSchema,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import { initServer } from '@ts-rest/fastify';

import type { CustomerWorkspace } from '../application/customers.js';

/** Exposes the tenant's imported customer profiles to readers with `customers.read`. */
export function customerRoutes(service?: CustomerWorkspace) {
  return initServer().router(apiContract.customers, {
    list: async ({ request, query }) => {
      if (!request.tenantContext)
        throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (!service)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Customers are unavailable',
        );

      return {
        status: 200,
        body: customerListSchema.parse(
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
          'Customer details are unavailable',
        );
      const detail = await service.get(
        request.tenantContext,
        params.customerId,
      );
      if (!detail)
        throw new IdentityError(404, 'NOT_FOUND', 'Customer not found');

      return { status: 200, body: customerDetailSchema.parse(detail) };
    },
  });
}
