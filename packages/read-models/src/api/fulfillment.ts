import '@luma/identity/http';

import {
  apiContract,
  fulfillmentDetailSchema,
  fulfillmentListSchema,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import { initServer } from '@ts-rest/fastify';

import type { FulfillmentWorkspace } from '../application/fulfillment.js';

/** Exposes the tenant's fulfillment work, shipments and their evidence to workspace members. */
export function fulfillmentRoutes(service?: FulfillmentWorkspace) {
  return initServer().router(apiContract.fulfillment, {
    list: async ({ request, query }) => {
      if (!request.tenantContext)
        throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (!service)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Fulfillment is unavailable',
        );

      return {
        status: 200,
        body: fulfillmentListSchema.parse(
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
          'Fulfillment details are unavailable',
        );
      const detail = await service.get(
        request.tenantContext,
        params.fulfillmentId,
      );
      if (!detail)
        throw new IdentityError(404, 'NOT_FOUND', 'Fulfillment not found');

      return { status: 200, body: fulfillmentDetailSchema.parse(detail) };
    },
  });
}
