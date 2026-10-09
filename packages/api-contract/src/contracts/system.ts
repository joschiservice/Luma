import { z } from 'zod';

import { endpoint } from '../common.js';

export const systemContract = {
  health: endpoint
    .route({
      method: 'GET',
      path: '/health',
      summary: 'Check whether the API is running',
    })
    .output(z.object({ status: z.literal('ok') })),
  ready: endpoint
    .route({
      method: 'GET',
      path: '/ready',
      summary: 'Check whether the API is ready to serve requests',
      description:
        'Returns 200 when ready and 503 when temporarily unavailable.',
    })
    .meta({ errors: [503] })
    .output(z.object({ status: z.literal('ready') })),
};
