import { createHash } from 'node:crypto';

import type { CoverageReader } from '@luma/connections';
import { IdentityError, requireTenant } from '@luma/identity';
import type { AttentionOrder, OrderMetricReader } from '@luma/orders';
import type { TenantDatabase } from '@luma/platform';

import {
  createMetricService,
  type OperationalMetrics,
} from '../application/metrics.js';
import { metricRequestSchema } from './metric-validation.js';

interface Readers {
  orders: (db: TenantDatabase) => OrderMetricReader;
  attention: (
    db: TenantDatabase,
  ) => (tenantId: string, asOf: string) => Promise<AttentionOrder[]>;
  coverage: (db: TenantDatabase) => CoverageReader;
}

/** Shares one repeatable-read transaction across domain readers and rejects changed cohorts. */
export function createOperationalMetrics(
  db: TenantDatabase,
  readers: Readers,
  now = () => new Date(),
): OperationalMetrics {
  return createMetricService({
    parse: (input) => metricRequestSchema.parse(input),
    now,
    read: async (context, request, asOf) => {
      return db.transaction(
        context.tenantId,
        async (tx) => {
          await tx.query("SET LOCAL statement_timeout = '3000ms'");
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
            throw new IdentityError(404, 'NOT_FOUND', 'Connection not found');
          const attention = await readers.attention(scoped)(
            context.tenantId,
            asOf,
          );
          const result = await readers.orders(scoped)(context, {
            ...request,
            asOf,
            attention,
          });
          const snapshot = createHash('sha256')
            .update(
              JSON.stringify([
                context.tenantId,
                request.definitionVersion,
                request.scope,
                asOf,
                result.revision,
                connections,
              ]),
            )
            .digest('hex');

          return { result, connections, snapshot };
        },
        { readOnlySnapshot: true },
      );
    },
  });
}
