import '@luma/identity/http';

import { apiContract, metricResponseSchema } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import { orderMetricDefinitions } from '@luma/orders';
import { initServer } from '@ts-rest/fastify';

import type { OperationalMetrics } from '../application/metrics.js';

/** Exposes registered definitions and tenant-authorized totals with matching cohorts. */
export function metricRoutes(service?: OperationalMetrics) {
  return initServer().router(apiContract.metrics, {
    definitions: async ({ request }) => {
      if (!request.tenantContext)
        throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');

      return {
        status: 200,
        body: orderMetricDefinitions.map((d) => ({
          ...d,
          dimensions: [...d.dimensions],
          filters: [...d.filters],
        })),
      };
    },
    query: async ({ request, body }) => {
      if (!request.tenantContext)
        throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (!service)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Operational metrics are unavailable',
        );

      return {
        status: 200,
        body: metricResponseSchema.parse(
          await service(request.tenantContext, body),
        ),
      };
    },
  });
}
