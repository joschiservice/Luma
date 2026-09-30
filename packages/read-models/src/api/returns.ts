import '@luma/identity/http';

import {
  apiContract,
  returnDetailSchema,
  returnListSchema,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import { initServer } from '@ts-rest/fastify';

import type { ReturnWorkspace } from '../application/returns.js';

/** Exposes the tenant's returns and refunds to workspace members. */
export function returnRoutes(service?: ReturnWorkspace) {
  return initServer().router(apiContract.returns, {
    list: async ({ request, query }) => {
      if (!request.tenantContext)
        throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (!service)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Returns are unavailable',
        );

      return {
        status: 200,
        body: returnListSchema.parse(
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
          'Return details are unavailable',
        );
      const detail = await service.get(request.tenantContext, params.returnId);
      if (!detail)
        throw new IdentityError(404, 'NOT_FOUND', 'Return not found');

      return { status: 200, body: returnDetailSchema.parse(detail) };
    },
  });
}
