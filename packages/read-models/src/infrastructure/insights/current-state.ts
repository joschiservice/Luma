import type {
  InsightChartResponse,
  InsightRecord,
  InsightRecordQuery,
  InsightSource,
  PurchaseOrderStage,
  StockRiskPosition,
} from '../../application/insights.js';
import {
  countPoints,
  procurementPoints,
  procurementSeries,
  stockPoint,
  stockPoints,
} from '../../domain/insights.js';

/*
 * Current-state charts whose rules the owners evaluate in code: stock risk from the
 * procurement owner's replenishment rule, and purchase-order stages from its commitments.
 * Charts and records filter the same classified list, so they always agree.
 */

/** Pages an in-memory record list. */
function page<T>(items: T[], query: InsightRecordQuery) {
  return {
    totalCount: items.length,
    items: items.slice(query.offset, query.offset + query.limit),
  };
}

/** Classifies monitored positions against their minimum. Unknown stock is never healthy. */
export function stockChart(
  positions: StockRiskPosition[],
  labels: Map<string, string>,
  asOf: string,
): InsightChartResponse {
  const points = countPoints(
    stockPoints.map((key) => ({ key })),
    ['positions'],
    positions.map((position) => ({
      point: stockPoint(position),
      series: 'positions',
      count: 1,
    })),
  );
  const unknown = positions.filter((p) => p.unknownReason);
  const sources: InsightSource[] = [
    ...new Set(positions.map((p) => p.connectionId)),
  ].map((connectionId) => ({
    connectionId,
    label: labels.get(connectionId) ?? 'Connected source',
    system: null,
    state: unknown.some((p) => p.connectionId === connectionId)
      ? 'stale'
      : 'complete',
    historyFrom: null,
    dataThrough: null,
    lastReadAt:
      positions
        .filter((p) => p.connectionId === connectionId && p.observedAt)
        .map((p) => p.observedAt!)
        .sort()
        .at(-1) ?? null,
  }));
  const observed = positions.flatMap((p) =>
    p.observedAt ? [p.observedAt] : [],
  );

  return {
    chart: 'stock',
    kind: 'breakdown',
    unit: 'stock_position',
    series: ['positions'],
    points,
    total: positions.length,
    window: null,
    sourceFilter: 'applied',
    coverage: {
      state: !positions.length
        ? 'unavailable'
        : unknown.length
          ? 'partial'
          : 'complete',
      sources,
      excluded: [],
    },
    // Every compared position was read at or after its oldest read.
    dataThrough:
      positions.length && !unknown.length ? observed.sort()[0]! : null,
    asOf,
  };
}

/** Lists the positions behind a stock point, furthest below minimum first. */
export function stockRecords(
  positions: StockRiskPosition[],
  labels: Map<string, string>,
  query: InsightRecordQuery,
) {
  const matched = positions
    .filter(
      (position) =>
        (!query.point || stockPoint(position) === query.point) &&
        (!query.series || query.series === 'positions'),
    )
    .sort(
      (a, b) =>
        (a.available ?? Infinity) -
          a.minimum -
          ((b.available ?? Infinity) - b.minimum) ||
        a.sku.localeCompare(b.sku) ||
        a.id.localeCompare(b.id),
    );
  const result = page(matched, query);

  return {
    totalCount: result.totalCount,
    items: result.items.map((position): InsightRecord => ({
      kind: 'stock_position',
      id: position.id,
      ruleId: position.ruleId,
      sku: position.sku,
      source: {
        connectionId: position.connectionId,
        label: labels.get(position.connectionId) ?? 'Connected source',
      },
      available: position.available,
      minimum: position.minimum,
      unit: position.unit,
      observedAt: position.observedAt,
      unknownReason: position.unknownReason,
      purchaseOrderIds: position.purchaseOrderIds,
    })),
  };
}

const active = (order: PurchaseOrderStage) =>
  procurementPoints.includes(order.stage);

/** Counts open purchase-order work by stage, separating orders with an overdue commitment. */
export function procurementChart(
  orders: PurchaseOrderStage[],
  asOf: string,
): InsightChartResponse {
  const points = countPoints(
    procurementPoints.map((key) => ({ key })),
    procurementSeries,
    orders.filter(active).map((order) => ({
      point: order.stage,
      series: order.overdue ? 'overdue' : 'not_overdue',
      count: 1,
    })),
  );

  return {
    chart: 'procurement',
    kind: 'breakdown',
    unit: 'purchase_order',
    series: procurementSeries,
    points,
    total: points.reduce((sum, point) => sum + point.total, 0),
    window: null,
    sourceFilter: 'not_applicable',
    coverage: { state: 'complete', sources: [], excluded: [] },
    dataThrough: asOf,
    asOf,
  };
}

/** Lists the purchase orders behind a stage, overdue and earliest expected first. */
export function procurementRecords(
  orders: PurchaseOrderStage[],
  query: InsightRecordQuery,
) {
  const matched = orders
    .filter(
      (order) =>
        active(order) &&
        (!query.point || order.stage === query.point) &&
        (!query.series ||
          (order.overdue ? 'overdue' : 'not_overdue') === query.series),
    )
    .sort(
      (a, b) =>
        Number(b.overdue) - Number(a.overdue) ||
        (a.expectedDate ?? '9999').localeCompare(b.expectedDate ?? '9999') ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
  const result = page(matched, query);

  return {
    totalCount: result.totalCount,
    items: result.items.map((order): InsightRecord => ({
      kind: 'purchase_order',
      ...order,
    })),
  };
}
