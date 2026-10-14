import '@luma/identity/http';

import {
  apiContract,
  returnDetailSchema,
  returnListSchema,
  returnsCatalog,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
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
          throw new IdentityError(
            401,
            'UNAUTHENTICATED',
            'Sign in to continue',
          );
        if (!service)
          throw new IdentityError(
            503,
            'SERVICE_UNAVAILABLE',
            'Returns are unavailable',
          );
        validateCollectionQuery(returnsCatalog, query);

        return returnListSchema.parse(
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
          'Return details are unavailable',
        );
      const detail = await service.get(request.tenantContext, params.returnId);
      if (!detail)
        throw new IdentityError(404, 'NOT_FOUND', 'Return not found');

      return returnDetailSchema.parse(detail);
    }),
  });
}
