import '@luma/identity/http';

import {
  apiContract,
  customerDetailSchema,
  customerListSchema,
  customersCatalog,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';

import type { CustomerWorkspace } from '../application/customers.js';
import { validateCollectionQuery } from './collection-validation.js';

/** Exposes the tenant's imported customer profiles to readers with `customers.read`. */
export function customerRoutes(service?: CustomerWorkspace) {
  const os = implement(apiContract.customers).$context<HttpContext>();

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
            'Customers are unavailable',
          );
        validateCollectionQuery(customersCatalog, query, {
          customFields: true,
        });

        return customerListSchema.parse(
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
          'Customer details are unavailable',
        );
      const detail = await service.get(
        request.tenantContext,
        params.customerId,
      );
      if (!detail)
        throw new IdentityError(404, 'NOT_FOUND', 'Customer not found');

      return customerDetailSchema.parse(detail);
    }),
  });
}
