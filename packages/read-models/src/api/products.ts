import '@luma/identity/http';

import {
  apiContract,
  productDetailSchema,
  productListSchema,
  productsCatalog,
} from '@luma/api-contract';
import type { HttpContext } from '@luma/identity/http';
import { notFound, ServiceError, unavailable } from '@luma/platform';
import { implement } from '@orpc/server';

import type { ProductWorkspace } from '../application/products.js';
import { validateCollectionQuery } from './collection-validation.js';

/** Exposes the tenant's product catalog comparison and SKU details to readers with `products.read`. */
export function productRoutes(service?: ProductWorkspace) {
  const os = implement(apiContract.products).$context<HttpContext>();

  return os.router({
    list: os.list.handler(
      async ({ context: { request }, input: { query } }) => {
        if (!request.tenantContext)
          throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
        if (!service) throw unavailable('Products are unavailable');
        validateCollectionQuery(productsCatalog, query, { customFields: true });

        return productListSchema.parse(
          await service.list(request.tenantContext, query),
        );
      },
    ),
    get: os.get.handler(async ({ context: { request }, input: { params } }) => {
      if (!request.tenantContext)
        throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (!service) throw unavailable('Product details are unavailable');
      const detail = await service.get(request.tenantContext, params.skuId);
      if (!detail) throw notFound('Product not found');

      return productDetailSchema.parse(detail);
    }),
  });
}
