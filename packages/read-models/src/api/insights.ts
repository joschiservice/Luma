import '@luma/identity/http';

import {
  apiContract,
  insightChartResponseSchema,
  insightRecordListSchema,
} from '@luma/api-contract';
import type { TenantContext } from '@luma/identity';
import { IdentityError } from '@luma/identity';
import { initServer } from '@ts-rest/fastify';

import type { Insights } from '../application/insights.js';

/** Exposes operational charts and the records behind each point to readers with `insights.read`. */
export function insightRoutes(service?: Insights) {
  const ready = (context: TenantContext | null | undefined) => {
    if (!context)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Insights are unavailable',
      );

    return { service, context };
  };

  return initServer().router(apiContract.insights, {
    chart: async ({ request, params, query }) => {
      const { service, context } = ready(request.tenantContext);

      return {
        status: 200,
        body: insightChartResponseSchema.parse(
          await service.chart(context, params.chart, query),
        ),
      };
    },
    records: async ({ request, params, query }) => {
      const { service, context } = ready(request.tenantContext);

      return {
        status: 200,
        body: insightRecordListSchema.parse(
          await service.records(context, params.chart, query),
        ),
      };
    },
  });
}
