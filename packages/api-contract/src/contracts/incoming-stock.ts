import { z } from 'zod';

import { endpoint, organizationParamsSchema, requires } from '../common.js';
import {
  incomingStockQuerySchema,
  incomingStockSchema,
} from '../incoming-stock.js';

export const incomingStockContract = {
  incomingStock: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations/{organizationId}/procurement/incoming-stock',
      summary: 'Read incoming supplier and transfer stock',
      description:
        'Shows outstanding supplier orders, in-transit location transfers, or the native ledger incoming balance for owned locations. Quantities never augment available stock. Unknown destinations and stale evidence remain explicit.',
    })
    .meta({
      access: requires('inventory.read'),
      errors: [401, 403, 404, 503],
      readOnly: true,
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: incomingStockQuerySchema,
      }),
    )
    .output(incomingStockSchema),
};
