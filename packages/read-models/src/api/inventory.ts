import '@luma/identity/http';

import {
  apiContract,
  inventoryDetailSchema,
  inventoryListSchema,
  transferDetailSchema,
  transferListSchema,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';

import type { InventoryWorkspace } from '../application/inventory.js';

/** Exposes the tenant's stock position list and stock position details to readers with `inventory.read`. */
export function inventoryRoutes(service?: InventoryWorkspace) {
  const os = implement(apiContract.inventory).$context<HttpContext>();

  return os.router({
    transfers: os.transfers.handler(
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
            'Transfers are unavailable',
          );

        return transferListSchema.parse(
          await service.listTransfers(request.tenantContext, query),
        );
      },
    ),
    transfer: os.transfer.handler(
      async ({ context: { request }, input: { params } }) => {
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
            'Transfer details are unavailable',
          );
        const detail = await service.getTransfer(
          request.tenantContext,
          params.transferId,
          params.connectionId,
        );
        if (!detail)
          throw new IdentityError(404, 'NOT_FOUND', 'Transfer not found');

        return transferDetailSchema.parse(detail);
      },
    ),
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
            'Inventory is unavailable',
          );

        return inventoryListSchema.parse(
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
          'Inventory details are unavailable',
        );
      const detail = await service.get(
        request.tenantContext,
        params.positionId,
      );
      if (!detail)
        throw new IdentityError(404, 'NOT_FOUND', 'Inventory not found');

      return inventoryDetailSchema.parse(detail);
    }),
  });
}
