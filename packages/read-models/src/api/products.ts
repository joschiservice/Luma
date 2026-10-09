import '@luma/identity/http';

import {
  apiContract,
  productDetailSchema,
  productListSchema,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';

import type { ProductWorkspace } from '../application/products.js';

/** Exposes the tenant's product catalog comparison and SKU details to readers with `products.read`. */
export function productRoutes(service?: ProductWorkspace) {
  const os = implement(apiContract.products).$context<HttpContext>();

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
            'Products are unavailable',
          );

        return productListSchema.parse(
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
          'Product details are unavailable',
        );
      const detail = await service.get(request.tenantContext, params.skuId);
      if (!detail)
        throw new IdentityError(404, 'NOT_FOUND', 'Product not found');

      return productDetailSchema.parse(detail);
    }),
  });
}
