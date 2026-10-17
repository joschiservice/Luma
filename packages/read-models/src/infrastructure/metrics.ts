import type { CoverageReader } from '@luma/connections';
import { requireTenant } from '@luma/identity';
import type { OrderMetricReader } from '@luma/orders';
import type { TenantDatabase } from '@luma/platform';
import { notFound } from '@luma/platform';

import {
  createMetricService,
  type OperationalMetrics,
} from '../application/metrics.js';
import { metricRequestSchema } from './metric-validation.js';

interface Readers {
  attentionBoundary?: (
    db: TenantDatabase,
  ) => (tenantId: string, asOf: string) => Promise<string | null>;
  orders: (db: TenantDatabase) => OrderMetricReader;
  coverage: (db: TenantDatabase) => CoverageReader;
}

/** Shares one repeatable-read transaction across the order and connection coverage readers. */
export function createOperationalMetrics(
  db: TenantDatabase,
  readers: Readers,
  now = () => new Date(),
): OperationalMetrics {
  return createMetricService({
    parse: (input) => metricRequestSchema.parse(input),
    now,
    read: async (context, request, asOf, limit, after) => {
      return db.transaction(
        context.tenantId,
        async (tx) => {
          await tx.query("SET LOCAL statement_timeout = '3000ms'");
          // JIT compilation of these large plans costs more than it saves on interactive reads.
          await tx.query('SET LOCAL jit = off');
          const scoped: TenantDatabase = {
            transaction: async (tenantId, operation) => {
              requireTenant(context, tenantId);

              return operation(tx);
            },
          };
          const connections = await readers.coverage(scoped)(context, asOf);
          if (
            request.scope.connectionId &&
            !connections.some((c) => c.id === request.scope.connectionId)
          )
            throw notFound('Connection not found');
          const result = await readers.orders(scoped)(context, {
            scope: request.scope,
            asOf,
            limit,
            after,
          });
          const boundary = await readers.attentionBoundary?.(scoped)(
            context.tenantId,
            asOf,
          );
          if (
            boundary &&
            (!result.nextRefreshAt ||
              Date.parse(boundary) < Date.parse(result.nextRefreshAt))
          )
            result.nextRefreshAt = boundary;

          return { result, connections };
        },
        { readOnlySnapshot: true },
      );
    },
  });
}
