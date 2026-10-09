import '@luma/identity/http';

import {
  apiContract,
  metricResponseSchema,
  operationalMetricDefinitionSchema,
  operationalMetricResponseSchema,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { orderMetricDefinitions } from '@luma/orders';
import { implement } from '@orpc/server';

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
  const os = implement(apiContract.metrics).$context<HttpContext>();

  return os.router({
    operationalDefinitions: os.operationalDefinitions.handler(
      async ({ context: { request } }) => {
        if (!request.tenantContext)
          throw new IdentityError(
            401,
            'UNAUTHENTICATED',
            'Sign in to continue',
          );

        return [
          ...orderMetricDefinitions.map((d) => ({
            ...d,
            dimensions: [...d.dimensions],
            filters: [...d.filters],
          })),
          ...operationalMetricDefinitions.map((d) =>
            operationalMetricDefinitionSchema.parse(d),
          ),
        ];
      },
    ),
    operationalQuery: os.operationalQuery.handler(
      async ({ context: { request }, input: { body } }) => {
        if (!request.tenantContext)
          throw new IdentityError(
            401,
            'UNAUTHENTICATED',
            'Sign in to continue',
          );
        if (!summary)
          throw new IdentityError(
            503,
            'SERVICE_UNAVAILABLE',
            'Operational metrics are unavailable',
          );

        return operationalMetricResponseSchema.parse(
          await summary(request.tenantContext, body),
        );
      },
    ),
    summary: os.summary.handler(
      async ({ context: { request }, input: { body } }) => {
        const context = request.tenantContext;
        if (!context)
          throw new IdentityError(
            401,
            'UNAUTHENTICATED',
            'Sign in to continue',
          );
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
          readAt: new Date().toISOString(),
          nextRefreshAt:
            boundaries[0] === undefined
              ? null
              : new Date(boundaries[0]).toISOString(),
          parts,
        };
      },
    ),
    definitions: os.definitions.handler(async ({ context: { request } }) => {
      if (!request.tenantContext)
        throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');

      return orderMetricDefinitions.map((d) => ({
        ...d,
        dimensions: [...d.dimensions],
        filters: [...d.filters],
      }));
    }),
    query: os.query.handler(
      async ({ context: { request }, input: { body } }) => {
        if (!request.tenantContext)
          throw new IdentityError(
            401,
            'UNAUTHENTICATED',
            'Sign in to continue',
          );
        if (!service)
          throw new IdentityError(
            503,
            'SERVICE_UNAVAILABLE',
            'Operational metrics are unavailable',
          );

        return metricResponseSchema.parse(
          await service(request.tenantContext, body),
        );
      },
    ),
  });
}
