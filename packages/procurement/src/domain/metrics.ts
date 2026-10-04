import type {
  OperationalMetricDefinition,
  OperationalMetricRead,
} from '@luma/platform';

import type { PurchaseOrder } from './procurement.js';
import { planReplenishment, type ReplenishmentRule } from './replenishment.js';

export interface StockMetricItem {
  kind: 'stock_position';
  id: string;
  ruleId: string;
  connectionId: string;
  sku: string;
  minimum: number;
  available: number | null;
  unit: string | null;
  observedAt: string | null;
  reason:
    | 'missing'
    | 'deleted'
    | 'nonnumeric'
    | 'future'
    | 'expired'
    | 'invalid_time'
    | null;
  commitmentIds: string[];
}

export interface PurchaseOrderMetricItem {
  kind: 'purchase_order';
  id: string;
  reference: string;
  supplierId: string;
  supplierName: string;
  authority: 'luma' | 'external';
  status: 'draft' | 'open';
  createdAt: string;
  ageSeconds: number | null;
}

export const procurementMetricDefinitions: OperationalMetricDefinition[] = [
  {
    id: 'procurement.purchase_orders.draft',
    title: 'Purchase-order drafts',
    description:
      'Distinct purchase orders currently in draft, recorded in Luma.',
  },
  {
    id: 'procurement.purchase_orders.open',
    title: 'Open purchase orders',
    description:
      'Open operational commitments recorded in Luma. Open does not establish supplier submission or acceptance.',
  },
].map((d) => ({
  ...d,
  version: 2,
  family: 'procurement',
  unit: 'purchase_order',
  filters: ['supplierId', 'authority'],
  permissions: 'workspace_member',
  timeSemantics: 'Exact current status at the read snapshot.',
}));

export const stockMetricDefinitions: OperationalMetricDefinition[] = [
  {
    id: 'inventory.below_minimum',
    title: 'Stock positions below minimum',
    description:
      'Active-rule positions with valid stock below the configured minimum. Existing commitments are draft or open orders for the same SKU across suppliers and sources; they do not establish sufficient incoming stock.',
  },
  {
    id: 'inventory.replenishment_unknown',
    title: 'Stock data needing review',
    description:
      'Active-rule positions with missing, deleted, nonnumeric, future-dated or expired stock from the configured connection.',
  },
].map((d) => ({
  ...d,
  version: 2,
  family: 'inventory',
  unit: 'stock_position',
  filters: ['connectionId'],
  permissions: 'workspace_member',
  timeSemantics:
    'Accepted configured-source stock must be less than five minutes old at asOf. Equality to minimum is not below minimum.',
}));

/** Finds draft/open commitments for the exact SKU, across suppliers and sources. */
export function replenishmentCommitments(
  orders: readonly PurchaseOrder[],
  sku: string,
  excludeOrder?: string,
) {
  return orders.filter(
    (o) =>
      o.id !== excludeOrder &&
      ['draft', 'open'].includes(o.status) &&
      o.lines.some((line) => line.sku === sku),
  );
}

/** Counts distinct persisted orders by current status, independent of line count. */
export function summarizePurchaseOrderMetrics(
  orders: PurchaseOrder[],
  asOf: string,
): OperationalMetricRead<PurchaseOrderMetricItem>[] {
  return procurementMetricDefinitions.map((definition) => {
    const status: 'draft' | 'open' = definition.id.endsWith('.draft')
      ? 'draft'
      : 'open';
    const items = orders
      .filter((o) => o.status === status)
      .map((o) => {
        const age = (Date.parse(asOf) - Date.parse(o.createdAt)) / 1000;

        return {
          kind: 'purchase_order' as const,
          id: o.id,
          reference: o.reference,
          supplierId: o.supplierId,
          supplierName: o.supplierName,
          authority: o.authority,
          status,
          createdAt: o.createdAt,
          ageSeconds: Number.isFinite(age) && age >= 0 ? Math.floor(age) : null,
        };
      });

    return {
      definition,
      value: items.length,
      total: items.length,
      observedCount: items.length,
      unknownCount: 0,
      population: orders.length,
      coverage: 'complete',
      coverageExplanation:
        'All matching purchase orders recorded in this workspace. External references do not establish a complete supplier or ERP sync.',
      freshness: 'fresh',
      observedAt: null,
      dataThrough: null,
      nextRefreshAt: items.length
        ? new Date(Date.parse(asOf) + 60_000).toISOString()
        : null,
      breakdown: [],
      items,
    };
  });
}

type Rule = ReplenishmentRule & { sku: string; active: boolean };

type Stock = {
  positionId: string;
  connectionId: string;
  available: number | null;
  unit: string;
  observedAt: string;
  deleted: boolean;
};

/**
 * Explains why configured-source stock can't support a replenishment decision at `now`, or null
 * when it is usable. Accepted stock is numeric, present at the source and less than five minutes
 * old.
 */
export function stockUnusableReason(
  stock: Pick<Stock, 'available' | 'observedAt' | 'deleted'> | undefined,
  now: number,
): StockMetricItem['reason'] {
  const age = stock ? now - Date.parse(stock.observedAt) : NaN;

  return !stock
    ? 'missing'
    : stock.deleted
      ? 'deleted'
      : stock.available === null || !Number.isFinite(stock.available)
        ? 'nonnumeric'
        : !Number.isFinite(age)
          ? 'invalid_time'
          : age < 0
            ? 'future'
            : age >= 300_000
              ? 'expired'
              : null;
}

/**
 * Classifies every active-rule position, including absent configured-source projections, with
 * whether its usable stock is below the rule minimum and the times at which the result changes.
 */
export function classifyStockPositions(
  rules: Rule[],
  stocks: Stock[],
  orders: PurchaseOrder[],
  asOf: string,
) {
  const now = Date.parse(asOf);
  const sources = new Map(
    stocks.map((stock) => [`${stock.positionId}:${stock.connectionId}`, stock]),
  );
  const positions = [
    ...new Map(
      rules
        .filter((rule) => rule.active)
        .map((rule) => [rule.positionId, rule]),
    ).values(),
  ];
  const boundaries: number[] = [];
  const classified = positions.map((rule) => {
    const stock = sources.get(`${rule.positionId}:${rule.connectionId}`);
    const age = stock ? now - Date.parse(stock.observedAt) : NaN;
    const reason = stockUnusableReason(stock, now);
    if (stock && Number.isFinite(age)) {
      if (age < 0) boundaries.push(Date.parse(stock.observedAt));
      if (age < 300_000)
        boundaries.push(Date.parse(stock.observedAt) + 300_000);
    }
    const commitmentIds = replenishmentCommitments(orders, rule.sku)
      .map((o) => o.id)
      .sort();
    const below = stock
      ? planReplenishment(rule, stock, commitmentIds.length > 0, now)
          .belowMinimum
      : false;
    const item: StockMetricItem = {
      kind: 'stock_position',
      id: rule.positionId,
      ruleId: rule.id,
      connectionId: rule.connectionId,
      sku: rule.sku,
      minimum: rule.minimum,
      available: stock?.available ?? null,
      unit: stock?.unit ?? null,
      observedAt: stock?.observedAt ?? null,
      reason,
      commitmentIds,
    };

    return { item, below };
  });

  return { classified, positions, boundaries };
}

/** Summarizes the stock metrics from `classifyStockPositions`. */
export function summarizeStockMetrics(
  rules: Rule[],
  stocks: Stock[],
  orders: PurchaseOrder[],
  asOf: string,
): OperationalMetricRead<StockMetricItem>[] {
  const { classified, positions, boundaries } = classifyStockPositions(
    rules,
    stocks,
    orders,
    asOf,
  );
  const unknown = classified.filter((row) => row.item.reason !== null).length;
  const observed = classified
    .flatMap((row) => (row.item.observedAt ? [row.item.observedAt] : []))
    .sort();

  return stockMetricDefinitions.map((definition) => {
    const isUnknown = definition.id.endsWith('_unknown');
    const items = classified
      .filter((row) => (isUnknown ? row.item.reason !== null : row.below))
      .map((row) => row.item);

    return {
      definition,
      value: items.length,
      total: isUnknown || !unknown ? items.length : null,
      observedCount: items.length,
      unknownCount: isUnknown ? 0 : unknown,
      population: positions.length,
      coverage: !positions.length
        ? 'unavailable'
        : unknown
          ? 'partial'
          : 'complete',
      coverageExplanation:
        'Only positions covered by active replenishment rules. No active rules does not establish healthy inventory.',
      freshness: !observed.length ? 'unobserved' : unknown ? 'stale' : 'fresh',
      observedAt: observed.at(-1) ?? null,
      dataThrough: null,
      nextRefreshAt: boundaries.length
        ? new Date(Math.min(...boundaries)).toISOString()
        : null,
      breakdown: isUnknown
        ? [
            'missing',
            'deleted',
            'nonnumeric',
            'future',
            'expired',
            'invalid_time',
          ].map((reason) => ({
            reason,
            count: items.filter((item) => item.reason === reason).length,
          }))
        : [
            {
              reason: 'existing_commitment',
              count: items.filter((item) => item.commitmentIds.length > 0)
                .length,
            },
            {
              reason: 'no_commitment',
              count: items.filter((item) => item.commitmentIds.length === 0)
                .length,
            },
          ],
      items,
    };
  });
}
