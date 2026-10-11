import type { CoverageReader } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { requirePermission } from '@luma/identity';
import type {
  OrderMetricId,
  OrderMetricRead,
  OrderMetricScope,
} from '@luma/orders';
import { orderMetricDefinitions, orderMetricIds } from '@luma/orders';

import { encodeMetricCursor, readMetricCursor } from './metric-pages.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MetricRequest {
  definitionVersion?: 1 | undefined;
  scope?: OrderMetricScope | undefined;
  limit?: number | undefined;
  /** A metric's `nextCursor`: that metric lists the orders after the previous page. */
  cursor?: string | undefined;
}

interface MetricResponse {
  nextRefreshAt?: string | null;
  definitionVersion: 1;
  scope: OrderMetricScope;
  asOf: string;
  readAt: string;
  timezone: 'UTC';
  observedAt: string | null;
  dataThrough: string | null;
  freshness: 'fresh' | 'stale' | 'unobserved';
  coverage: 'partial' | 'unavailable';
  coverageExplanation: string;
  limit: number;
  metrics: (OrderMetricRead['metrics'][number] & {
    definition: (typeof orderMetricDefinitions)[number];
    total: null;
    offset: number;
    nextCursor: string | null;
  })[];
}

/** Reads registered metrics and a page of matching orders for each, from current data. */
export type OperationalMetrics = (
  context: TenantContext,
  request: MetricRequest,
) => Promise<MetricResponse>;

interface ParsedMetricRequest {
  definitionVersion: 1;
  scope: OrderMetricScope;
  limit: number;
  cursor?: string | undefined;
}

/**
 * Applies authorization and shared coverage semantics to registered order metrics. Readers need
 * `orders.read`; others get a 403 error. Every page reads current data: records that changed
 * since the previous page don't fail the read, and callers deduplicate by ID.
 */
export function createMetricService(dependencies: {
  parse(input: MetricRequest): ParsedMetricRequest;
  read(
    context: TenantContext,
    request: ParsedMetricRequest,
    asOf: string,
    limit: number,
    after: { metric: OrderMetricId; id: string } | undefined,
  ): Promise<{
    result: OrderMetricRead;
    connections: Awaited<ReturnType<CoverageReader>>;
  }>;
  now(): Date;
}): OperationalMetrics {
  return async (context, input) => {
    requirePermission(context, 'orders.read');
    const request = dependencies.parse(input);
    const asOf = dependencies.now().toISOString();
    const { limit } = request;
    // Orders page by ID, so a cursor's key is one order ID.
    const cursor = readMetricCursor(
      request.cursor,
      orderMetricIds,
      (key) => key.length === 1 && uuid.test(key[0]!),
    );
    const paged = orderMetricIds.find((id) => id === cursor?.metric);
    // One extra order shows whether another page follows.
    const { result, connections } = await dependencies.read(
      context,
      request,
      asOf,
      limit + 1,
      paged && cursor?.key[0]
        ? { metric: paged, id: cursor.key[0] }
        : undefined,
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
      readAt: asOf,
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
      limit,
      metrics: result.metrics.map((metric) => {
        const offset = metric.id === paged ? (cursor?.offset ?? 0) : 0;
        const items = metric.items.slice(0, limit);

        return {
          ...metric,
          items,
          definition: orderMetricDefinitions.find((d) => d.id === metric.id)!,
          total: null,
          offset,
          nextCursor:
            metric.items.length > limit
              ? encodeMetricCursor({
                  metric: metric.id,
                  offset: offset + limit,
                  key: [items.at(-1)!.id],
                })
              : null,
        };
      }),
    };
  };
}
