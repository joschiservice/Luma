import '@luma/identity/http';

import {
  apiContract,
  inventoryDetailSchema,
  inventoryListSchema,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import { initServer } from '@ts-rest/fastify';

import type { InventoryWorkspace } from '../application/inventory.js';

/** Exposes the tenant's stock position list and stock position details to workspace members. */
export function inventoryRoutes(service?: InventoryWorkspace) {
  return initServer().router(apiContract.inventory, {
    list: async ({ request, query }) => {
      if (!request.tenantContext)
        throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (!service)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Inventory is unavailable',
        );

      return {
        status: 200,
        body: inventoryListSchema.parse(
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
          'Inventory details are unavailable',
        );
      const detail = await service.get(
        request.tenantContext,
        params.positionId,
      );
      if (!detail)
        throw new IdentityError(404, 'NOT_FOUND', 'Inventory not found');

      return { status: 200, body: inventoryDetailSchema.parse(detail) };
    },
  });
}
