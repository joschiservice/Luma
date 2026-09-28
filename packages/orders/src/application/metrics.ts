import type { TenantContext } from '@luma/identity';

export interface OrderMetricScope {
  connectionId?: string | undefined;
  updatedFrom?: string | undefined;
  updatedBefore?: string | undefined;
}

export interface OrderMetricRow {
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

export interface AttentionOrder {
  orderId: string;
  issueId: string;
}

export interface OrderMetricRead {
  revision: string;
  observedAt: string | null;
  oldestObservedAt: string | null;
  dataThrough: string | null;
  population: number;
  metrics: {
    id: 'orders.open' | 'orders.overdue' | 'orders.attention';
    observedCount: number;
    unknownCount: number;
    items: OrderMetricRow[];
  }[];
}

/** Reads totals and bounded cohorts from the same accepted canonical facts. */
export type OrderMetricReader = (
  context: TenantContext,
  request: {
    scope: OrderMetricScope;
    asOf: string;
    limit: number;
    offset: number;
    attention: AttentionOrder[];
  },
) => Promise<OrderMetricRead>;
