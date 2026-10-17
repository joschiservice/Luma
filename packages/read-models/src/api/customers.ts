import '@luma/identity/http';

import {
  apiContract,
  customerDetailSchema,
  customerListSchema,
  customersCatalog,
} from '@luma/api-contract';
import type { HttpContext } from '@luma/identity/http';
import { notFound, ServiceError, unavailable } from '@luma/platform';
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
          throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
        if (!service) throw unavailable('Customers are unavailable');
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
        throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (!service) throw unavailable('Customer details are unavailable');
      const detail = await service.get(
        request.tenantContext,
        params.customerId,
      );
      if (!detail) throw notFound('Customer not found');

      return customerDetailSchema.parse(detail);
    }),
  });
}
