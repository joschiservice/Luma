import type { IncomingStock } from './incoming.js';
import type { PurchaseOrderInput } from './procurement.js';

export interface PurchasingStock {
  positionId: string;
  skuId: string;
  sku: string;
  locationId: string;
  location: string;
  connectionId: string;
  unit: string;
  available: number | null;
  reserved: number | null;
  observedAt: string;
  observationId: string;
  complete: boolean;
  authoritative: boolean;
}

export interface PurchasingDemand {
  daily: number | null;
  units: number | null;
  periodDays: number;
  observedAt: string | null;
  evidenceRefs: string[];
  complete: boolean;
}

/** Computes an explainable quantity without inventing missing quantities or terms. */
export function recommendPurchase(input: {
  stocks: PurchasingStock[];
  demand: PurchasingDemand;
  leadTimeDays: number | null;
  packSize: number | null;
  minimumQuantity: number | null;
  safetyDays: number;
  committed: boolean;
  incomingQuantity?: number | undefined;
  rule: { minimum: number; target: number } | null;
  now: number;
}) {
  const missing: string[] = [];
  if (!input.stocks.length) missing.push('stock_missing');
  if (input.stocks.some((s) => !s.authoritative))
    missing.push('stock_authority');
  if (input.stocks.some((s) => !s.complete || s.available === null))
    missing.push('stock_incomplete');
  if (
    input.stocks.some((s) => {
      const age = input.now - Date.parse(s.observedAt);

      return !Number.isFinite(age) || age < 0 || age >= 300_000;
    })
  )
    missing.push('stock_stale');
  if (new Set(input.stocks.map((s) => s.unit)).size > 1)
    missing.push('unit_mismatch');
  if (input.packSize === null || input.packSize <= 0) missing.push('pack_size');
  if (input.minimumQuantity === null || input.minimumQuantity < 0)
    missing.push('minimum_quantity');
  if (!input.rule && (input.demand.daily === null || !input.demand.complete))
    missing.push('demand_incomplete');
  if (!input.rule && input.leadTimeDays === null) missing.push('lead_time');
  const available =
    input.stocks.length && input.stocks.every((s) => s.available !== null)
      ? input.stocks.reduce((sum, s) => sum + s.available!, 0)
      : null;
  const daysOfCover =
    available !== null && input.demand.daily !== null && input.demand.daily > 0
      ? available / input.demand.daily
      : null;
  const rawQuantity =
    missing.length || available === null || input.committed
      ? null
      : input.rule
        ? available < input.rule.minimum
          ? Math.max(
              0,
              Math.ceil(
                input.rule.target - available - (input.incomingQuantity ?? 0),
              ),
            )
          : 0
        : Math.max(
            0,
            Math.ceil(
              input.demand.daily! * (input.leadTimeDays! + input.safetyDays) -
                available -
                (input.incomingQuantity ?? 0),
            ),
          );
  const quantity =
    rawQuantity === null
      ? null
      : rawQuantity === 0
        ? 0
        : Math.ceil(
            Math.max(rawQuantity, input.minimumQuantity!) / input.packSize!,
          ) * input.packSize!;
  const bounded =
    quantity === null ||
    (Number.isSafeInteger(quantity) && quantity <= 1_000_000);
  if (!bounded) missing.push('quantity_limit');
  const orderBy =
    daysOfCover !== null && input.leadTimeDays !== null
      ? new Date(
          input.now +
            (daysOfCover - input.leadTimeDays - input.safetyDays) * 86_400_000,
        ).toISOString()
      : null;

  return {
    available,
    daysOfCover,
    rawQuantity,
    quantity: bounded ? quantity : null,
    orderBy,
    missing,
  };
}

/** Workspace purchasing assumptions use complete evidence for the selected locations. */
export interface PurchasingSettings {
  demandPeriodDays: number;
  safetyDays: number;
  locationIds: string[];
  revision: number;
}

/** An explainable supplier/product recommendation with explicit unavailable inputs. */
export interface PurchasingRecommendation {
  key: string;
  supplierId: string;
  supplierName: string;
  skuId: string;
  sku: string;
  termsRevision: number;
  termsObservedAt: string | null;
  packSize: number | null;
  minimumQuantity: number | null;
  leadTimeDays: number | null;
  supplierArticleNumber: string | null;
  unitPrice: { amount: string; currency: string } | null;
  orderMinimumValue: { amount: string; currency: string } | null;
  stocks: PurchasingStock[];
  incoming: IncomingStock['items'];
  incomingQuantity: number | null;
  demand: PurchasingDemand;
  existingOrders: {
    id: string;
    reference: string;
    quantity: number;
    status: 'draft' | 'open';
  }[];
  rule: { minimum: number; target: number } | null;
  available: number | null;
  daysOfCover: number | null;
  rawQuantity: number | null;
  quantity: number | null;
  orderBy: string | null;
  missing: string[];
}

export interface PurchasingOverview {
  enabled: boolean;
  plansEnabled: boolean;
  canManage: boolean;
  settings: PurchasingSettings;
  items: PurchasingRecommendation[];
  locations: { id: string; name: string }[];
  asOf: string;
  truncated: boolean;
}

/** The requested quantities and terms revisions; snapshots are read on the server. */
export interface PurchasingPlanInput {
  id: string;
  supplierId: string;
  reference: string;
  lines: {
    skuId: string;
    locationId: string;
    quantity: number;
    termsRevision: number;
  }[];
  reason: string;
  sourceOrderId?: string | undefined;
  attentionKey?: string | undefined;
}

/** An immutable request bound to a governed action and its independent result. */
export interface PurchasingPlan {
  id: string;
  tenantId: string;
  supplierId: string;
  requestedBy: string;
  createdAt: string;
  expiresAt: string;
  request: PurchasingPlanInput;
  order: PurchaseOrderInput;
  suggestions: {
    skuId: string;
    locationId: string;
    suggested: number | null;
    chosen: number;
    sourceConnectionIds?: string[] | undefined;
    target?: number | null | undefined;
    evidenceRefs: string[];
  }[];
  decisionId: string | null;
  state:
    | 'approval_required'
    | 'approved'
    | 'rejected'
    | 'withheld'
    | 'uncertain'
    | 'verified'
    | 'failed'
    | 'expired';
  failure: string | null;
  actionId: string;
  canApprove?: boolean | undefined;
  canExecute?: boolean | undefined;
}

/** Converts validated purchasing prices into exact millionths-plus units for comparisons. */
export function purchasingAmountUnits(amount: string): bigint {
  if (!/^\d+(?:\.\d{1,8})?$/.test(amount))
    throw new Error('Invalid purchasing amount.');
  const [whole, fraction = ''] = amount.split('.');

  return BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
}
