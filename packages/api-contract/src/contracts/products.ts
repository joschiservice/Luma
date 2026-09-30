import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import { apiErrorSchema, organizationParamsSchema } from '../common.js';
import {
  productDetailSchema,
  productListSchema,
  productQuerySchema,
} from '../products.js';

const c = initContract();

export const productsContract = c.router({
  list: {
    method: 'GET',
    path: '/v1/organizations/:organizationId/products',
    pathParams: organizationParamsSchema,
    query: productQuerySchema,
    responses: {
      200: productListSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Browse the product catalog',
    description:
      'List SKUs from the connected catalogs and compare each source’s title, status, listing, price and barcode. No source is treated as authoritative. `differs` returns SKUs whose sources disagree; `missing` returns SKUs absent from at least one catalog source; `unlinked` returns SKUs with an unlinked SKU of the same code in another source. Prices are compared only within the same reported currency. Results contain up to `limit` SKUs (at most 50) with counts per view; nextCursor continues the same filters.',
  },
  get: {
    method: 'GET',
    path: '/v1/organizations/:organizationId/products/:skuId',
    pathParams: organizationParamsSchema.extend({ skuId: z.string().uuid() }),
    responses: {
      200: productDetailSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Inspect a product SKU',
    description:
      'Compare one SKU across sources and see what depends on it: other variants, up to 50 observed listing snapshots, stock positions, units ordered in the last 30 days per source, orders, purchase orders and issues (up to 50 each). Sales are not added across sources because systems can mirror the same order. Purchase orders are commitments, not confirmed incoming stock.',
  },
});
