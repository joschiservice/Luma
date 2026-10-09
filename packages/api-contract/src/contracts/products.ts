import { z } from 'zod';

import { endpoint, organizationParamsSchema, requires } from '../common.js';
import {
  productDetailSchema,
  productListSchema,
  productQuerySchema,
} from '../products.js';

export const productsContract = {
  list: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/products',
      summary: 'Browse the product catalog',
      description:
        'List SKUs from the connected catalogs and compare each source’s title, status, listing, price and barcode. No source is treated as authoritative. `differs` returns SKUs whose sources disagree; `missing` returns SKUs absent from at least one catalog source; `unlinked` returns SKUs with an unlinked SKU of the same code in another source. Prices are compared only within the same reported currency. Results contain up to `limit` SKUs (at most 50) with counts per view; nextCursor continues the same filters.',
    })
    .meta({ access: requires('products.read'), errors: [400, 401, 404, 503] })
    .input(
      z.object({ params: organizationParamsSchema, query: productQuerySchema }),
    )
    .output(productListSchema),
  get: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/products/{skuId}',
      summary: 'Inspect a product SKU',
      description:
        'Compare one SKU across sources and see what depends on it: other variants, up to 50 observed listing snapshots, stock positions, units ordered in the last 30 days per source, orders, purchase orders and issues (up to 50 each). Sales are not added across sources because systems can mirror the same order. Purchase orders are commitments, not confirmed incoming stock.',
    })
    .meta({ access: requires('products.read'), errors: [401, 404, 503] })
    .input(
      z.object({
        params: organizationParamsSchema.extend({ skuId: z.string().uuid() }),
      }),
    )
    .output(productDetailSchema),
};
