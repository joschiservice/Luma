import { z } from 'zod';

import { endpoint } from '../common.js';

const connectorProviderSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  category: z.enum(['storefront', 'erp']),
});

export type ConnectorProvider = z.infer<typeof connectorProviderSchema>;

export const connectorProvidersContract = {
  list: endpoint
    .route({
      method: 'GET',
      path: '/v1/connector-providers',
      summary: 'List connector providers',
      description:
        'Browse provider names and categories. Filter by storefront or ERP.',
    })
    .input(
      z.object({
        query: z
          .object({ category: z.enum(['storefront', 'erp']).optional() })
          .strict(),
      }),
    )
    .output(z.object({ items: z.array(connectorProviderSchema) })),
  get: endpoint
    .route({
      method: 'GET',
      path: '/v1/connector-providers/{providerId}',
      summary: 'Get a connector provider',
      description:
        'Look up a provider by its ID. Returns 404 if the provider is not in the catalog.',
    })
    .meta({ errors: [404] })
    .input(
      z.object({
        params: z.object({
          providerId: z
            .string()
            .min(1)
            .max(64)
            .regex(/^[a-z][a-z0-9-]*$/),
        }),
      }),
    )
    .output(connectorProviderSchema),
};
