import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import { apiErrorSchema, organizationParamsSchema } from '../common.js';
import {
  inventoryDetailSchema,
  inventoryListSchema,
  inventoryQuerySchema,
} from '../inventory.js';

const c = initContract();

export const inventoryContract = c.router({
  list: {
    method: 'GET',
    path: '/v1/organizations/:organizationId/inventory',
    pathParams: organizationParamsSchema,
    query: inventoryQuerySchema,
    responses: {
      200: inventoryListSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Browse inventory',
    description:
      'Search SKUs and locations and compare current stock quantities by source. Quantities are never added across sources. Null means unknown. Results contain up to 50 positions; nextCursor continues the same filters. Source filters select positions while retaining all sources for comparison.',
  },
  get: {
    method: 'GET',
    path: '/v1/organizations/:organizationId/inventory/:positionId',
    pathParams: organizationParamsSchema.extend({
      positionId: z.string().uuid(),
    }),
    responses: {
      200: inventoryDetailSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Inspect a stock position',
    description:
      'Compare sources for one SKU, location and unit. Includes up to 100 observed snapshots and 50 entries per related record type. Orders and purchase orders relate to the SKU; they do not confirm location allocation or incoming supply. Product relationships and incoming quantities remain unknown until a source reports them.',
  },
});
