import '@luma/identity/http';

import {
  apiContract,
  productDetailSchema,
  productListSchema,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import { initServer } from '@ts-rest/fastify';

import type { ProductWorkspace } from '../application/products.js';

/** Exposes the tenant's product catalog comparison and SKU details to readers with `products.read`. */
export function productRoutes(service?: ProductWorkspace) {
  return initServer().router(apiContract.products, {
    list: async ({ request, query }) => {
      if (!request.tenantContext)
        throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (!service)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Products are unavailable',
        );

      return {
        status: 200,
        body: productListSchema.parse(
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
          'Product details are unavailable',
        );
      const detail = await service.get(request.tenantContext, params.skuId);
      if (!detail)
        throw new IdentityError(404, 'NOT_FOUND', 'Product not found');

      return { status: 200, body: productDetailSchema.parse(detail) };
    },
  });
}
