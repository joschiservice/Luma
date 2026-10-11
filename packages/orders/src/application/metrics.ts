import type { TenantContext } from '@luma/identity';

import type { OrderMetricId } from '../domain/metrics.js';

export interface OrderMetricScope {
  connectionId?: string | undefined;
  updatedFrom?: string | undefined;
  updatedBefore?: string | undefined;
}

interface OrderMetricRow {
  id: string;
  displayNumber: string | null;
  connectionId: string;
  dueAt: string | null;
  observedAt: string;
  sourceUpdatedAt: string | null;
  open: boolean | null;
  overdue: boolean | null;
  attention: boolean;
  issueIds: string[];
}

export interface OrderMetricRead {
  nextRefreshAt?: string | null;
  observedAt: string | null;
  oldestObservedAt: string | null;
  dataThrough: string | null;
  population: number;
  metrics: {
    id: OrderMetricId;
    observedCount: number;
    unknownCount: number;
    items: OrderMetricRow[];
  }[];
}

/**
 * Reads totals and bounded cohorts from the same accepted canonical facts. Each cohort lists up
 * to `limit` orders by ID; the `after` metric starts after that order ID.
 */
export type OrderMetricReader = (
  context: TenantContext,
  request: {
    scope: OrderMetricScope;
    asOf: string;
    limit: number;
    after?: { metric: OrderMetricId; id: string } | undefined;
  },
) => Promise<OrderMetricRead>;
