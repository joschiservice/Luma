import '@luma/identity/http';

import {
  apiContract,
  inventoryCatalog,
  inventoryDetailSchema,
  inventoryListSchema,
  transferDetailSchema,
  transferListSchema,
  transfersCatalog,
} from '@luma/api-contract';
import type { HttpContext } from '@luma/identity/http';
import { notFound, ServiceError, unavailable } from '@luma/platform';
import { implement } from '@orpc/server';

import type { InventoryWorkspace } from '../application/inventory.js';
import { validateCollectionQuery } from './collection-validation.js';

/** Exposes the tenant's stock position list and stock position details to readers with `inventory.read`. */
export function inventoryRoutes(service?: InventoryWorkspace) {
  const os = implement(apiContract.inventory).$context<HttpContext>();

  return os.router({
    transfers: os.transfers.handler(
      async ({ context: { request }, input: { query } }) => {
        if (!request.tenantContext)
          throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
        if (!service) throw unavailable('Transfers are unavailable');
        validateCollectionQuery(transfersCatalog, query);

        return transferListSchema.parse(
          await service.listTransfers(request.tenantContext, query),
        );
      },
    ),
    transfer: os.transfer.handler(
      async ({ context: { request }, input: { params } }) => {
        if (!request.tenantContext)
          throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
        if (!service) throw unavailable('Transfer details are unavailable');
        const detail = await service.getTransfer(
          request.tenantContext,
          params.transferId,
          params.connectionId,
        );
        if (!detail) throw notFound('Transfer not found');

        return transferDetailSchema.parse(detail);
      },
    ),
    list: os.list.handler(
      async ({ context: { request }, input: { query } }) => {
        if (!request.tenantContext)
          throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
        if (!service) throw unavailable('Inventory is unavailable');
        validateCollectionQuery(inventoryCatalog, query);

        return inventoryListSchema.parse(
          await service.list(request.tenantContext, query),
        );
      },
    ),
    get: os.get.handler(async ({ context: { request }, input: { params } }) => {
      if (!request.tenantContext)
        throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (!service) throw unavailable('Inventory details are unavailable');
      const detail = await service.get(
        request.tenantContext,
        params.positionId,
      );
      if (!detail) throw notFound('Inventory not found');

      return inventoryDetailSchema.parse(detail);
    }),
  });
}
