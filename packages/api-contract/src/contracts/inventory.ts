import { z } from 'zod';

import { endpoint, organizationParamsSchema, requires } from '../common.js';
import {
  inventoryDetailSchema,
  inventoryListSchema,
  inventoryQuerySchema,
} from '../inventory.js';

export const inventoryContract = {
  list: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/inventory',
      summary: 'Browse inventory',
      description:
        'Search SKUs and locations and compare current stock quantities by source. Quantities are never added across sources. Null means unknown. Results contain up to 50 positions; nextCursor continues the same filters. Source filters select positions while retaining all sources for comparison.',
    })
    .meta({ access: requires('inventory.read'), errors: [400, 401, 404, 503] })
    .input(
      z.object({
        params: organizationParamsSchema,
        query: inventoryQuerySchema,
      }),
    )
    .output(inventoryListSchema),
  get: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/inventory/{positionId}',
      summary: 'Inspect a stock position',
      description:
        'Compare sources for one SKU, location and unit. Includes up to 100 observed snapshots and 50 entries per related record type. Orders and purchase orders relate to the SKU; they do not confirm location allocation or incoming supply. Product relationships and incoming quantities remain unknown until a source reports them.',
    })
    .meta({ access: requires('inventory.read'), errors: [401, 404, 503] })
    .input(
      z.object({
        params: organizationParamsSchema.extend({
          positionId: z.string().uuid(),
        }),
      }),
    )
    .output(inventoryDetailSchema),
};
