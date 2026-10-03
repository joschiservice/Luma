import type { TenantContext } from '@luma/identity';

import type { InsightCoverage, InsightPoint } from '../domain/insights.js';

export type {
  InsightCoverage,
  InsightPoint,
  InsightPointCoverage,
  InsightSource,
  InsightSourceState,
} from '../domain/insights.js';

export type InsightChart =
  'orders' | 'fulfillment' | 'stock' | 'cases' | 'procurement';

export type InsightRange = '7d' | '30d' | '13w';

export type InsightUnit =
  'order' | 'fulfillment' | 'stock_position' | 'case' | 'purchase_order';

export interface InsightQuery {
  range: InsightRange;
  timeZone: string;
  connectionId?: string | undefined;
}

export interface InsightRecordQuery extends InsightQuery {
  point?: string | undefined;
  series?: string | undefined;
  asOf?: string | undefined;
  offset: number;
  limit: number;
}

export interface InsightWindow {
  range: InsightRange;
  bucket: 'day' | 'week';
  start: string;
  end: string;
  from: string;
  before: string;
  timeZone: string;
}

export interface InsightChartResponse {
  chart: InsightChart;
  kind: 'timeline' | 'breakdown';
  unit: InsightUnit;
  series: string[];
  points: InsightPoint[];
  total: number;
  window: InsightWindow | null;
  sourceFilter: 'applied' | 'not_applicable';
  coverage: InsightCoverage;
  dataThrough: string | null;
  asOf: string;
}

type RecordSource = { connectionId: string; label: string };

export type InsightRecord =
  | {
      kind: 'order';
      id: string;
      number: string | null;
      placedAt: string | null;
      status: string;
      fulfillment: string;
      total: { amount: string; currency: string } | null;
      sources: RecordSource[];
      attentionIssueIds: string[];
    }
  | {
      kind: 'fulfillment';
      id: string;
      source: RecordSource;
      workKind: string | null;
      status: string;
      signals: string[];
      progressAt: string;
      lastProgressAt: string | null;
      fulfillBy: string | null;
      locationName: string | null;
      units: string;
      unit: string | null;
      order: { id: string; number: string | null };
    }
  | {
      kind: 'stock_position';
      id: string;
      ruleId: string;
      sku: string;
      source: RecordSource;
      available: number | null;
      minimum: number;
      unit: string | null;
      observedAt: string | null;
      unknownReason: string | null;
      purchaseOrderIds: string[];
    }
  | {
      kind: 'case';
      id: string;
      class: string;
      severity: string | null;
      state: string;
      detectedAt: string;
      resolvedAt: string | null;
      resolution: 'verified' | 'human_disposition' | null;
      attention: string | null;
    }
  | {
      kind: 'purchase_order';
      id: string;
      reference: string;
      supplierName: string;
      stage: string;
      expectedDate: string | null;
      overdue: boolean;
      attention: number;
      nextOwner: string;
      createdAt: string;
    };

export interface InsightRecordList {
  chart: InsightChart;
  point: string | null;
  series: string | null;
  totalCount: number;
  items: InsightRecord[];
  nextOffset: number | null;
  asOf: string;
}

/** A monitored stock position classified by the procurement owner's replenishment rule. */
export interface StockRiskPosition {
  id: string;
  ruleId: string;
  connectionId: string;
  sku: string;
  minimum: number;
  available: number | null;
  unit: string | null;
  observedAt: string | null;
  /** Why the stock can't be compared, or null when it was usable. */
  unknownReason: string | null;
  belowMinimum: boolean;
  purchaseOrderIds: string[];
}

/** A purchase order with the stage the procurement owner derives from its evidence. */
export interface PurchaseOrderStage {
  id: string;
  reference: string;
  supplierName: string;
  stage: string;
  expectedDate: string | null;
  overdue: boolean;
  attention: number;
  nextOwner: string;
  createdAt: string;
}

/**
 * Reads operational charts and the records behind each point. A chart value and the matching
 * record list come from the same rules, so they agree when read at the same `asOf`.
 */
export interface Insights {
  chart(
    context: TenantContext,
    chart: InsightChart,
    query: InsightQuery,
  ): Promise<InsightChartResponse>;
  records(
    context: TenantContext,
    chart: InsightChart,
    query: InsightRecordQuery,
  ): Promise<InsightRecordList>;
}
