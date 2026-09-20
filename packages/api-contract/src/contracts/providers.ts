import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import { apiErrorSchema } from '../common.js';

const c = initContract();

export const connectorProviderSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  category: z.enum(['storefront', 'erp']),
});

export type ConnectorProvider = z.infer<typeof connectorProviderSchema>;

export const connectorProvidersContract = c.router(
  {
    list: {
      method: 'GET',
      path: '/connector-providers',
      query: z
        .object({ category: z.enum(['storefront', 'erp']).optional() })
        .strict(),
      responses: {
        200: z.object({ items: z.array(connectorProviderSchema) }),
      },
      summary: 'List connector providers',
      description:
        'Browse provider names and categories. Filter by storefront or ERP.',
    },
    get: {
      method: 'GET',
      path: '/connector-providers/:providerId',
      pathParams: z.object({
        providerId: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z][a-z0-9-]*$/),
      }),
      responses: { 200: connectorProviderSchema, 404: apiErrorSchema },
      summary: 'Get a connector provider',
      description:
        'Look up a provider by its ID. Returns 404 if the provider is not in the catalog.',
    },
  },
  { pathPrefix: '/v1' },
);
