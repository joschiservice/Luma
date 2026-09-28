import type { CoverageReader } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { IdentityError, requireTenant } from '@luma/identity';
import type { OrderMetricRead, OrderMetricScope } from '@luma/orders';
import { orderMetricDefinitions } from '@luma/orders';

export interface MetricRequest {
  definitionVersion?: 1 | undefined;
  scope?: OrderMetricScope | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  asOf?: string | undefined;
  snapshot?: string | undefined;
}

export interface MetricResponse {
  nextRefreshAt?: string | null;
  definitionVersion: 1;
  scope: OrderMetricScope;
  asOf: string;
  readAt: string;
  snapshot: string;
  timezone: 'UTC';
  observedAt: string | null;
  dataThrough: string | null;
  freshness: 'fresh' | 'stale' | 'unobserved';
  coverage: 'partial' | 'unavailable';
  coverageExplanation: string;
  limit: number;
  offset: number;
  metrics: (OrderMetricRead['metrics'][number] & {
    definition: (typeof orderMetricDefinitions)[number];
    total: null;
  })[];
}

/** Reads registered metrics and matching orders in one authorized snapshot. */
export type OperationalMetrics = (
  context: TenantContext,
  request: MetricRequest,
) => Promise<MetricResponse>;

interface ParsedMetricRequest extends MetricRequest {
  definitionVersion: 1;
  scope: OrderMetricScope;
  limit: number;
  offset: number;
}

/** Applies authorization, snapshot expiry and shared coverage semantics to registered metrics. */
export function createMetricService(dependencies: {
  parse(input: MetricRequest): ParsedMetricRequest;
  read(
    context: TenantContext,
    request: ParsedMetricRequest,
    asOf: string,
  ): Promise<{
    result: OrderMetricRead;
    connections: Awaited<ReturnType<CoverageReader>>;
    snapshot: string;
  }>;
  now(): Date;
}): OperationalMetrics {
  return async (context, input) => {
    requireTenant(context, context.tenantId);
    const request = dependencies.parse(input);
    const readAt = dependencies.now().toISOString();
    const asOf = request.asOf ?? readAt;
    if (
      Date.parse(asOf) > Date.parse(readAt) ||
      Date.parse(readAt) - Date.parse(asOf) > 15 * 60_000
    )
      throw new IdentityError(
        409,
        'CONFLICT',
        'This snapshot expired. Refresh the metrics.',
      );

    const { result, connections, snapshot } = await dependencies.read(
      context,
      request,
      asOf,
    );
    if (request.snapshot && request.snapshot !== snapshot)
      throw new IdentityError(
        409,
        'CONFLICT',
        'The matching records changed. Refresh the metrics.',
      );
    const monitored = connections.filter(
      (c) =>
        (!request.scope.connectionId || c.id === request.scope.connectionId) &&
        c.status !== 'disconnected',
    );

    const boundaries = [
      result.nextRefreshAt,
      ...monitored.map((c) => c.nextRefreshAt),
    ].filter((value): value is string => !!value);

    return {
      nextRefreshAt: boundaries.length
        ? new Date(Math.min(...boundaries.map(Date.parse))).toISOString()
        : null,
      definitionVersion: 1,
      scope: request.scope,
      asOf,
      readAt,
      snapshot,
      timezone: 'UTC',
      observedAt: result.observedAt,
      dataThrough: null,
      freshness: !result.observedAt
        ? 'unobserved'
        : !!result.oldestObservedAt &&
            Date.parse(asOf) - Date.parse(result.oldestObservedAt) <=
              86400000 &&
            monitored.length > 0 &&
            monitored.every(
              (c) => c.status === 'active' && c.freshness === 'fresh',
            )
          ? 'fresh'
          : 'stale',
      coverage: result.population > 0 ? 'partial' : 'unavailable',
      coverageExplanation:
        'Complete order and fulfillment scans are not established. Observed counts may omit orders; totals remain unavailable.',
      limit: request.limit,
      offset: request.offset,
      metrics: result.metrics.map((metric) => ({
        ...metric,
        definition: orderMetricDefinitions.find((d) => d.id === metric.id)!,
        total: null,
      })),
    };
  };
}
