import { z } from 'zod';

import { endpoint, organizationParamsSchema, requires } from '../common.js';
import {
  inventoryDetailSchema,
  inventoryListSchema,
  inventoryQuerySchema,
} from '../inventory.js';
import {
  transferDetailSchema,
  transferListSchema,
  transferQuerySchema,
} from '../inventory-transfers.js';

export const inventoryContract = {
  transfers: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/inventory/transfers',
      summary: 'Browse inventory transfers and shipments',
      description:
        'Read up to 50 source summaries with separately reported stages. Transfer and shipment quantities do not augment stock balances. Signals require active grants and complete evidence observed within five minutes; a past arrival estimate establishes only that receipt is unconfirmed.',
    })
    .meta({ access: requires('inventory.read'), errors: [400, 401, 404, 503] })
    .input(
      z.object({
        params: organizationParamsSchema,
        query: transferQuerySchema,
      }),
    )
    .output(transferListSchema),
  transfer: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/inventory/transfers/{transferId}/sources/{connectionId}',
      summary: 'Inspect transfer or receiving evidence',
      description:
        'Read one source projection, exact line identities, historical location snapshots, up to 20 observations and 50 explicit relationships per type. Null collections are unavailable. Procurement links require procurement.read and an exact connection-scoped external reference. No stock, receiving or claim action is executed.',
    })
    .meta({ access: requires('inventory.read'), errors: [401, 404, 503] })
    .input(
      z.object({
        params: organizationParamsSchema.extend({
          transferId: z.string().uuid(),
          connectionId: z.string().uuid(),
        }),
      }),
    )
    .output(transferDetailSchema),
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
        'Compare sources for one SKU, location and unit. Includes up to 100 observed snapshots and 50 entries per related record type. Orders and purchase orders relate to the SKU; they do not confirm location allocation or incoming supply. Incoming quantities and distinct provider stock states remain unknown until reported. Location activity, item activation and tracking are separate facts; quantities do not establish sellability.',
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
