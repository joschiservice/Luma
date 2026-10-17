import '@luma/identity/http';

import {
  apiContract,
  fulfillmentCatalog,
  fulfillmentDetailSchema,
  fulfillmentListSchema,
} from '@luma/api-contract';
import type { HttpContext } from '@luma/identity/http';
import { notFound, ServiceError, unavailable } from '@luma/platform';
import { implement } from '@orpc/server';

import type { FulfillmentWorkspace } from '../application/fulfillment.js';
import { validateCollectionQuery } from './collection-validation.js';

/** Exposes the tenant's fulfillment work, shipments and their evidence to readers with `fulfillment.read`. */
export function fulfillmentRoutes(service?: FulfillmentWorkspace) {
  const os = implement(apiContract.fulfillment).$context<HttpContext>();

  return os.router({
    list: os.list.handler(
      async ({ context: { request }, input: { query } }) => {
        if (!request.tenantContext)
          throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
        if (!service) throw unavailable('Fulfillment is unavailable');
        validateCollectionQuery(fulfillmentCatalog, query);

        return fulfillmentListSchema.parse(
          await service.list(request.tenantContext, query),
        );
      },
    ),
    get: os.get.handler(async ({ context: { request }, input: { params } }) => {
      if (!request.tenantContext)
        throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (!service) throw unavailable('Fulfillment details are unavailable');
      const detail = await service.get(
        request.tenantContext,
        params.fulfillmentId,
      );
      if (!detail) throw notFound('Fulfillment not found');

      return fulfillmentDetailSchema.parse(detail);
    }),
  });
}
