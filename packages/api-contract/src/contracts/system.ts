import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import { apiErrorSchema } from '../common.js';

const c = initContract();

export const systemContract = c.router({
  health: {
    method: 'GET',
    path: '/health',
    responses: { 200: z.object({ status: z.literal('ok') }) },
    summary: 'Check whether the API is running',
  },
  ready: {
    method: 'GET',
    path: '/ready',
    responses: {
      200: z.object({ status: z.literal('ready') }),
      503: apiErrorSchema,
    },
    summary: 'Check whether the API is ready to serve requests',
    description: 'Returns 200 when ready and 503 when temporarily unavailable.',
  },
});
