import '@luma/identity/http';

import {
  apiContract,
  returnDetailSchema,
  returnListSchema,
  returnsCatalog,
} from '@luma/api-contract';
import type { HttpContext } from '@luma/identity/http';
import { notFound, ServiceError, unavailable } from '@luma/platform';
import { implement } from '@orpc/server';

import type { ReturnWorkspace } from '../application/returns.js';
import { validateCollectionQuery } from './collection-validation.js';

/** Exposes the tenant's returns and refunds to readers with `returns.read`. */
export function returnRoutes(service?: ReturnWorkspace) {
  const os = implement(apiContract.returns).$context<HttpContext>();

  return os.router({
    list: os.list.handler(
      async ({ context: { request }, input: { query } }) => {
        if (!request.tenantContext)
          throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
        if (!service) throw unavailable('Returns are unavailable');
        validateCollectionQuery(returnsCatalog, query);

        return returnListSchema.parse(
          await service.list(request.tenantContext, query),
        );
      },
    ),
    get: os.get.handler(async ({ context: { request }, input: { params } }) => {
      if (!request.tenantContext)
        throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (!service) throw unavailable('Return details are unavailable');
      const detail = await service.get(request.tenantContext, params.returnId);
      if (!detail) throw notFound('Return not found');

      return returnDetailSchema.parse(detail);
    }),
  });
}
