import { createHash } from 'node:crypto';

import type { ConnectionMetricItem, CoverageReader } from '@luma/connections';
import { summarizeConnectionMetrics } from '@luma/connections';
import type { CaseMetricItem } from '@luma/exceptions';
import type { TenantContext } from '@luma/identity';
import { hasPermission, IdentityError, requireTenant } from '@luma/identity';
import type { OperationalMetricRead, TenantDatabase } from '@luma/platform';
import type {
  PurchaseOrderMetricItem,
  StockMetricItem,
} from '@luma/procurement';
import type { ResolutionMetricReader } from '@luma/resolution';

import {
  metricFamilyPermissions,
  type OperationalCohortItem,
  operationalMetricDefinitions,
  type OperationalSummary,
  type OperationalSummaryRequest,
} from '../application/operational-summary.js';
import { operationalMetricRequestSchema } from './operational-metric-validation.js';

interface Readers {
  resolution?(db: TenantDatabase): ResolutionMetricReader;
  cases(
    db: TenantDatabase,
  ): (
    tenantId: string,
    asOf: string,
  ) => Promise<OperationalMetricRead<CaseMetricItem>[]>;
  procurement(
    db: TenantDatabase,
  ): (
    context: TenantContext,
    asOf: string,
    family: 'inventory' | 'procurement',
    scope: NonNullable<OperationalSummaryRequest['scope']>,
  ) => Promise<
    | OperationalMetricRead<PurchaseOrderMetricItem>[]
    | OperationalMetricRead<StockMetricItem>[]
  >;
  coverage(db: TenantDatabase): CoverageReader;
}

/** Presents a metric the reader may not read: unavailable, without value or records. */
function withheldMetric(
  id: string,
): OperationalMetricRead<OperationalCohortItem> {
  const definition = operationalMetricDefinitions.find((d) => d.id === id)!;

  return {
    definition,
    value: null,
    total: null,
    observedCount: 0,
    unknownCount: 0,
    population: 0,
    coverage: 'unavailable',
    coverageExplanation:
      'Your role doesn’t include access to this area. Ask a workspace admin for access.',
    freshness: 'unobserved',
    observedAt: null,
    dataThrough: null,
    nextRefreshAt: null,
    breakdown: [],
    items: [],
  };
}

/** Composes only requested domain families in a repeatable-read transaction with revision-checked pagination. */
export function createOperationalSummary(
  db: TenantDatabase,
  readers: Readers,
  now = () => new Date(),
): OperationalSummary {
  return async (context, input) => {
    requireTenant(context, context.tenantId);
    const request = operationalMetricRequestSchema.parse(input);
    const readAt = now().toISOString();
    const asOf = request.asOf ?? readAt;
    if (
      Date.parse(asOf) > Date.parse(readAt) ||
      Date.parse(readAt) - Date.parse(asOf) > 900_000
    )
      throw new IdentityError(
        409,
        'CONFLICT',
        'This snapshot expired. Refresh the metrics.',
      );

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
        const hidden = request.metrics.filter((id) => {
          const permission = metricFamilyPermissions[id.split('.')[0]!];

          return !!permission && !hasPermission(context, permission);
        });
        const results = hidden.map(withheldMetric);
        const families = new Set(
          request.metrics
            .filter((id) => !hidden.includes(id))
            .map((id) => id.split('.')[0]),
        );
        if (families.has('resolution')) {
          if (!readers.resolution)
            throw new IdentityError(
              503,
              'SERVICE_UNAVAILABLE',
              'Resolution measurements are unavailable',
            );
          results.push(
            ...(await readers.resolution(scoped)(
              context.tenantId,
              asOf,
              request.scope,
            )),
          );
        }
        if (families.has('cases'))
          results.push(
            ...(await readers.cases(scoped)(context.tenantId, asOf)),
          );
        if (families.has('inventory'))
          results.push(
            ...(await readers.procurement(scoped)(
              context,
              asOf,
              'inventory',
              request.scope,
            )),
          );
        if (families.has('procurement'))
          results.push(
            ...(await readers.procurement(scoped)(
              context,
              asOf,
              'procurement',
              request.scope,
            )),
          );
        if (families.has('connections')) {
          const connections = await readers.coverage(scoped)(context, asOf);
          results.push(
            ...(summarizeConnectionMetrics(
              connections.filter(
                (c) =>
                  !request.scope.connectionId ||
                  c.id === request.scope.connectionId,
              ),
            ) as OperationalMetricRead<ConnectionMetricItem>[]),
          );
        }
        const metrics = request.metrics.map((id) =>
          results.find((result) => result.definition.id === id)!,
        );
        const snapshot = createHash('sha256')
          .update(
            JSON.stringify([
              context.tenantId,
              request.definitionVersion,
              request.metrics,
              request.scope,
              asOf,
              metrics,
            ]),
          )
          .digest('hex');
        if (request.snapshot && request.snapshot !== snapshot)
          throw new IdentityError(
            409,
            'CONFLICT',
            'The matching records changed. Refresh the metrics.',
          );
        const boundaries = metrics
          .flatMap((metric) =>
            metric.nextRefreshAt ? [metric.nextRefreshAt] : [],
          )
          .sort();

        return {
          definitionVersion: 2,
          scope: request.scope,
          asOf,
          readAt,
          snapshot,
          timezone: 'UTC',
          nextRefreshAt: boundaries[0] ?? null,
          limit: request.limit,
          offset: request.offset,
          hidden,
          metrics: metrics.map((metric) => ({
            ...metric,
            items: metric.items
              .slice(request.offset, request.offset + request.limit)
              .map((item) =>
                item.kind === 'resolution'
                  ? {
                      ...item,
                      evidenceRefCount: item.evidenceRefs.length,
                      factCount: item.factIds.length,
                      evidenceRefs: item.evidenceRefs.slice(0, 50),
                      factIds: item.factIds.slice(0, 50),
                    }
                  : item,
              ),
          })),
        };
      },
      { readOnlySnapshot: true },
    );
  };
}
