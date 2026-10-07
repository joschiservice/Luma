import '@luma/identity/http';

import {
  apiContract,
  metricResponseSchema,
  operationalMetricDefinitionSchema,
  operationalMetricResponseSchema,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import { orderMetricDefinitions } from '@luma/orders';
import { initServer } from '@ts-rest/fastify';

import type { OperationalMetrics } from '../application/metrics.js';
import {
  operationalMetricDefinitions,
  type OperationalSummary,
} from '../application/operational-summary.js';

/**
 * Exposes registered definitions and tenant-authorized totals with matching cohorts. The summary
 * route reads several order and operational views in one request so a page shares one live read.
 */
export function metricRoutes(
  service?: OperationalMetrics,
  summary?: OperationalSummary,
) {
  return initServer().router(apiContract.metrics, {
    operationalDefinitions: async ({ request }) => {
      if (!request.tenantContext)
        throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');

      return {
        status: 200,
        body: [
          ...orderMetricDefinitions.map((d) => ({
            ...d,
            dimensions: [...d.dimensions],
            filters: [...d.filters],
          })),
          ...operationalMetricDefinitions.map((d) =>
            operationalMetricDefinitionSchema.parse(d),
          ),
        ],
      };
    },
    operationalQuery: async ({ request, body }) => {
      if (!request.tenantContext)
        throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (!summary)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Operational metrics are unavailable',
        );

      return {
        status: 200,
        body: operationalMetricResponseSchema.parse(
          await summary(request.tenantContext, body),
        ),
      };
    },
    summary: async ({ request, body }) => {
      const context = request.tenantContext;
      if (!context)
        throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      const parts = await Promise.all(
        body.parts.map(async (part) => {
          try {
            if (part.kind === 'orders') {
              if (!service)
                throw new IdentityError(
                  503,
                  'SERVICE_UNAVAILABLE',
                  'Operational metrics are unavailable',
                );

              return {
                kind: part.kind,
                status: 200 as const,
                body: metricResponseSchema.parse(
                  await service(context, part.request),
                ),
              };
            }
            if (!summary)
              throw new IdentityError(
                503,
                'SERVICE_UNAVAILABLE',
                'Operational metrics are unavailable',
              );

            return {
              kind: part.kind,
              status: 200 as const,
              body: operationalMetricResponseSchema.parse(
                await summary(context, part.request),
              ),
            };
          } catch (error) {
            // Access and snapshot outcomes belong to the part; other failures fail the request.
            if (!(error instanceof IdentityError)) throw error;

            return {
              kind: part.kind,
              status: error.statusCode,
              error: {
                code: error.code,
                message: error.message,
                requestId: request.id,
              },
            };
          }
        }),
      );
      const boundaries = parts
        .flatMap((part) =>
          'body' in part && part.body.nextRefreshAt
            ? [Date.parse(part.body.nextRefreshAt)]
            : [],
        )
        .sort((a, b) => a - b);

      return {
        status: 200,
        body: {
          readAt: new Date().toISOString(),
          nextRefreshAt:
            boundaries[0] === undefined
              ? null
              : new Date(boundaries[0]).toISOString(),
          parts,
        },
      };
    },
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
